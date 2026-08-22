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
import {requiredValue, stubLocalStorage} from './test-utils'

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
describe('service: make_invoice / lookup_invoice (continued)', () => {
  it('drains a rejected invoice settlement and reports it before stop resolves', async () => {
    const m = await mint({testHooks: true})
    const commit = deferred()
    const commitError = new Error('invoice commit rejected during stop')
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
    const stopping = stop().then(() => {
      stopped = true
      return state.errors.length
    })
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
    expect(stopped).toBe(false)

    commit.reject(commitError)
    expect(await stopping).toBe(1)
    expect(state.errors).toEqual([commitError])
    expect(state.changesets).toHaveLength(0)
    await stop()
  })

  it('does not block stop on an invoice whose claim is still polling', async () => {
    // an unpaid invoice's claim poll can legally run for minutes (the
    // client pays whenever it pays) - stop must interrupt the wait, not
    // sit on it; a settlement that already REACHED the commit phase is
    // still awaited (see the drain tests above)
    const m = await mint({testHooks: true})
    const {relay, walletServicePubkey, state, stop} = await startTestService({
      defaultMint: `mint@127.0.0.1:${m.port}`,
      claimPoll: {intervalMs: 50, intervalCapMs: 50, maxWaitMs: 60_000},
    })
    const made = await call(relay, walletServicePubkey, 'make_invoice', {
      amount: 5_000,
    })
    expect(made.error).toBeNull()

    // nobody pays the invoice; the claim keeps polling. stop must resolve
    // promptly regardless (an un-interrupted stop would wait out the
    // whole 60s claim budget)
    await stop()
    expect(state.changesets).toHaveLength(0)
    expect(state.errors).toHaveLength(0)
  })

  it('does not start invoice settlement after stop begins during preparation', async () => {
    const m = await mint({testHooks: true})
    const prepare = deferred()
    let prepareStarted = false
    const {relay, walletServicePubkey, state, stop} = await startTestService({
      defaultMint: `mint@127.0.0.1:${m.port}`,
      kit: {
        fetch: async (input, init) => {
          prepareStarted = true
          await prepare.promise
          return fetch(input, init)
        },
      },
    })
    const request = methodRequest(walletServicePubkey, 'make_invoice', {
      amount: 21_000,
    })
    relay.emit(request)
    await waitFor(() => prepareStarted)

    let stopped = false
    const stopping = stop().then(() => {
      stopped = true
    })
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
    expect(stopped).toBe(false)

    prepare.resolve()
    await stopping

    expect(state.changesets).toHaveLength(0)
    expect(readResponse(relay.published, request.id, 'nip44_v2')?.error?.code).toBe('INTERNAL')
  })

  it('marks a paid invoice failed when its bearer commit rejects', async () => {
    const m = await mint({testHooks: true})
    const commit = deferred()
    const commitError = new Error('invoice bearer commit failed')
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
    commit.reject(commitError)
    await waitFor(() => state.errors.length === 1)

    const failed = await call(relay, walletServicePubkey, 'lookup_invoice', {
      payment_hash: paymentHash,
    })
    expect(failed.result?.state).toBe('failed')
    expect(failed.result?.settled_at).toBeUndefined()
    expect(failed.result?.preimage).toBeUndefined()
    expect(state.errors).toEqual([commitError])
    await stop()
  })

  it('finds an invoice by its invoice string too', async () => {
    const m = await mint({testHooks: true})
    const {relay, walletServicePubkey, stop} = await startTestService({
      defaultMint: `mint@127.0.0.1:${m.port}`,
      claimPoll: {intervalMs: 1, intervalCapMs: 2, maxWaitMs: 10},
    })
    const made = await call(relay, walletServicePubkey, 'make_invoice', {
      amount: 5_000,
    })
    const invoice = made.result?.invoice
    if (typeof invoice !== 'string') {
      throw new TypeError('make_invoice did not return an invoice')
    }
    const found = await call(relay, walletServicePubkey, 'lookup_invoice', {
      invoice: invoice.toUpperCase(),
    })
    expect(found.error).toBeNull()
    expect(found.result?.payment_hash).toBe(made.result?.payment_hash)
    await stop()
  })

  it('answers an unknown invoice with NOT_FOUND', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const response = await call(relay, walletServicePubkey, 'lookup_invoice', {
      payment_hash: 'ab'.repeat(32),
    })
    expect(response.error?.code).toBe('NOT_FOUND')
    await stop()
  })

  it('answers make_invoice without a default mint with INTERNAL', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({
      defaultMint: null,
    })
    const response = await call(relay, walletServicePubkey, 'make_invoice', {
      amount: 21_000,
    })
    expect(response.error?.code).toBe('INTERNAL')
    await stop()
  })

  it('answers a make_invoice with a bad amount with OTHER', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const response = await call(relay, walletServicePubkey, 'make_invoice', {
      amount: -5,
    })
    expect(response.error?.code).toBe('OTHER')
    await stop()
  })
})
