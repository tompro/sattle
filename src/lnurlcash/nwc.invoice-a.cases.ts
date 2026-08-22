// The NWC wallet service end to end: connection strings and key
// derivation, the request/response cycle over an in-memory relay (the
// transport is injected - no network), every method against the
// conformance mock mint, the legacy NIP-04 path, budget enforcement, and
// the error paths. Fund-safety focus: budgets can't be exceeded, stale
// requests never execute, and a settled preimage only ever reveals an
// already-rotated (burned) note secret.

import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {finalizeEvent, getPublicKey} from 'nostr-tools/pure'
import {encrypt as nip04Encrypt, decrypt as nip04Decrypt} from 'nostr-tools/nip04'
import {v2 as nip44v2} from 'nostr-tools/nip44'
import {buildNoteUrl, fetchNoteInfo, noteK1} from 'lnurlcash-kit'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'

import {
  NWC_INFO_KIND,
  NWC_REQUEST_KIND,
  NWC_RESPONSE_KIND,
  buildConnectionString,
  connectionInfoOf,
  createConnection,
  deriveNwcWalletKey,
  migrateLegacyNwcStorage,
  parseConnectionString,
  readNwcEnabled,
  readNwcConnections,
  startService,
  writeNwcEnabled,
  writeNwcConnections,
} from './nwc'
import type {NostrEvent, NwcConnectionRecord, NwcServiceDeps, NwcTransport} from './nwc'
import type {NostrFilter} from './nwc/transport'
import type {NwcChangeset} from './nwc'
import type {Bearer} from './types'
import {ensureSavedKeyOwner, linkingPubKeyHex, saveLinkingKey} from './keys'
import {requiredString, requiredValue, stubLocalStorage} from './test-utils'

import {
  CLIENT_PUBKEY,
  CLIENT_SECRET,
  FAST_POLL,
  LINKING_KEY,
  OTHER_LINKING_KEY,
  OTHER_OWNER_ID,
  OWNER_ID,
  RELAYS,
  STRANGER_SECRET,
  clientRequest,
  createFakeRelay,
  deferred,
  foreignConnectionFixture,
  methodRequest,
  nowSeconds,
  storeForeignConnection,
  waitFor,
} from './nwc.testProtocol'
import {call, makeBearer, mint, readResponse, startTestService} from './nwc.testService'
describe('service: make_invoice / lookup_invoice', () => {
  it('issues an invoice, settles it in the background, and reports the preimage', async () => {
    const m = await mint({testHooks: true})
    const {relay, walletServicePubkey, state, stop} = await startTestService({
      defaultMint: `mint@127.0.0.1:${m.port}`,
    })

    const made = await call(relay, walletServicePubkey, 'make_invoice', {
      amount: 21_000,
      description: 'nwc test',
      expiry: 3600,
    })
    expect(made.error).toBeNull()
    expect(made.result).toMatchObject({
      type: 'incoming',
      state: 'pending',
      amount: 21_000,
      description: 'nwc test',
      created_at: nowSeconds(),
      expires_at: nowSeconds() + 3600,
    })
    const invoice = requiredValue(made.result).invoice
    if (typeof invoice !== 'string') {
      throw new TypeError('make_invoice did not return an invoice')
    }
    const paymentHash = made.result?.payment_hash
    if (typeof paymentHash !== 'string') {
      throw new TypeError('make_invoice did not return a payment hash')
    }
    expect(invoice).toMatch(/^lnbc/)
    expect(paymentHash).toMatch(/^[0-9a-f]{64}$/)

    // before settlement the lookup reports the pending invoice
    const pending = await call(relay, walletServicePubkey, 'lookup_invoice', {
      payment_hash: paymentHash,
    })
    expect(pending.error).toBeNull()
    expect(pending.result?.state).toBe('pending')
    expect(pending.result?.preimage).toBeUndefined()

    // the "payer" pays the invoice; the background claim settles and
    // mints the note
    const settleRes = await fetch(`${m.url}/_test/settle?payment_hash=${paymentHash}`)
    expect(settleRes.ok).toBe(true)
    await waitFor(() => state.changesets.some((c) => c.add.length > 0))

    const settled = await call(relay, walletServicePubkey, 'lookup_invoice', {
      payment_hash: paymentHash,
    })
    expect(settled.error).toBeNull()
    expect(settled.result?.state).toBe('settled')
    expect(settled.result?.settled_at).toBe(nowSeconds())
    const preimage = requiredString(settled.result?.preimage)
    expect(preimage).toMatch(/^[0-9a-f]{64}$/)

    // the minted note was claimed AND rotated before settlement was
    // recorded: the preimage the client just learned is a burned secret,
    // and the wallet's fresh note is the only live one
    expect(m.state.noteState(preimage)).toBe('burned')
    const minted = requiredValue(state.bearers.find((b) => b.id.startsWith('added-')))
    expect(minted.amount).toBe(21_000)
    expect(minted.verified).toBe(true)
    expect(noteK1(minted.url)).not.toBe(preimage)
    expect(m.state.noteState(requiredValue(noteK1(minted.url)))).toBe('outstanding')
    await stop()
  })

  it('keeps a paid invoice pending while its bearer commit is deferred', async () => {
    const m = await mint({testHooks: true})
    const commit = deferred()
    let commitStarted = false
    const {relay, walletServicePubkey, state, stop} = await startTestService({
      defaultMint: `mint@127.0.0.1:${m.port}`,
      commitChangeset: () => {
        commitStarted = true
        return commit.promise
      },
    })
    const made = await call(relay, walletServicePubkey, 'make_invoice', {
      amount: 21_000,
    })
    const paymentHash = made.result?.payment_hash
    if (typeof paymentHash !== 'string') {
      throw new TypeError('make_invoice did not return a payment hash')
    }

    const settleResponse = await fetch(`${m.url}/_test/settle?payment_hash=${paymentHash}`)
    expect(settleResponse.ok).toBe(true)
    await waitFor(() => commitStarted)

    const pending = await call(relay, walletServicePubkey, 'lookup_invoice', {
      payment_hash: paymentHash,
    })
    expect(pending.result?.state).toBe('pending')
    expect(pending.result?.settled_at).toBeUndefined()
    expect(pending.result?.preimage).toBeUndefined()

    commit.resolve()
    await waitFor(() => state.changesets.length === 1)
    const settled = await call(relay, walletServicePubkey, 'lookup_invoice', {
      payment_hash: paymentHash,
    })
    expect(settled.result?.state).toBe('settled')
    expect(settled.result?.settled_at).toBe(nowSeconds())
    expect(settled.result?.preimage).toMatch(/^[0-9a-f]{64}$/)
    await stop()
  })

  it('keeps repeated stops pending until an already-started invoice settlement commits', async () => {
    const m = await mint({testHooks: true})
    const commit = deferred()
    let commitStarted = false
    const {relay, walletServicePubkey, state, stop} = await startTestService({
      defaultMint: `mint@127.0.0.1:${m.port}`,
      commitChangeset: () => {
        commitStarted = true
        return commit.promise
      },
    })
    const made = await call(relay, walletServicePubkey, 'make_invoice', {
      amount: 21_000,
    })
    const paymentHash = made.result?.payment_hash
    if (typeof paymentHash !== 'string') {
      throw new TypeError('make_invoice did not return a payment hash')
    }
    const settleResponse = await fetch(`${m.url}/_test/settle?payment_hash=${paymentHash}`)
    expect(settleResponse.ok).toBe(true)
    await waitFor(() => commitStarted)

    let stopped = false
    const firstStop = stop().then(() => {
      stopped = true
      return state.changesets.length
    })
    const repeatedStop = stop()
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()

    expect(stopped).toBe(false)
    expect(state.changesets).toHaveLength(0)

    commit.resolve()
    const [changesetsAtStop] = await Promise.all([firstStop, repeatedStop])
    expect(changesetsAtStop).toBe(1)
    expect(state.changesets).toHaveLength(1)
  })
})
