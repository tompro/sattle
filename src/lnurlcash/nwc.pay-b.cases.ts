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
describe('service: pay_invoice (continued)', () => {
  it('rejects a payment over the connection budget with QUOTA_EXCEEDED', async () => {
    const m = await mint()
    const {relay, walletServicePubkey, state, stop} = await startTestService({
      budgetMsat: 20_000,
    })
    state.bearers = [await makeBearer(m, 'ee'.repeat(32), 21_000)]

    const response = await call(relay, walletServicePubkey, 'pay_invoice', {
      invoice: 'lnbc210n1pjqrstuvwxyz',
    })
    expect(response.error?.code).toBe('QUOTA_EXCEEDED')
    // nothing moved: the note is untouched, no spend recorded
    expect(m.state.noteState('ee'.repeat(32))).toBe('outstanding')
    expect(requiredValue(state.bearers[0]).spent).toBeUndefined()
    expect(requiredValue(readNwcConnections(OWNER_ID)[0]).spent.msat).toBe(0)
    await stop()
  })

  it('resets the allowance once the budget period has rolled over', async () => {
    const m = await mint()
    const {relay, walletServicePubkey, state, stop} = await startTestService({
      budgetMsat: 21_000,
      periodMs: 60_000,
    })
    // simulate a fully spent budget from a period that ended long ago
    const record: NwcConnectionRecord = requiredValue(readNwcConnections(OWNER_ID)[0])
    writeNwcConnections(OWNER_ID, [
      {...record, spent: {periodStart: Date.now() - 120_000, msat: 21_000}},
    ])
    state.bearers = [await makeBearer(m, 'ef'.repeat(32), 21_000)]

    const response = await call(relay, walletServicePubkey, 'pay_invoice', {
      invoice: 'lnbc210n1pjqrstuvwxyz',
    })
    expect(response.error).toBeNull()
    expect(requiredValue(readNwcConnections(OWNER_ID)[0]).spent.msat).toBe(21_000)
    await stop()
  })

  it('rejects a payment the wallet cannot cover with INSUFFICIENT_BALANCE', async () => {
    const m = await mint()
    const {relay, walletServicePubkey, state, stop} = await startTestService({})
    state.bearers = [await makeBearer(m, 'ff'.repeat(32), 5_000)]

    const response = await call(relay, walletServicePubkey, 'pay_invoice', {
      invoice: 'lnbc210n1pjqrstuvwxyz',
    })
    expect(response.error?.code).toBe('INSUFFICIENT_BALANCE')
    expect(m.state.noteState('ff'.repeat(32))).toBe('outstanding')
    await stop()
  })

  it('rejects a request amount that mismatches the invoice amount', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const response = await call(relay, walletServicePubkey, 'pay_invoice', {
      invoice: 'lnbc210n1pjqrstuvwxyz',
      amount: 5_000,
    })
    expect(response.error?.code).toBe('OTHER')
    expect(response.error?.message).toMatch(/match/i)
    await stop()
  })

  it('rejects an amount-less invoice instead of guessing', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const response = await call(relay, walletServicePubkey, 'pay_invoice', {
      invoice: 'lnbc1pjqrstuvwxyz',
    })
    expect(response.error?.code).toBe('OTHER')
    expect(response.error?.message).toMatch(/amount/i)
    await stop()
  })

  it('answers a failed melt with PAYMENT_FAILED and tracks the returned funds', async () => {
    const m = await mint({meltAlwaysFails: true})
    const {relay, walletServicePubkey, state, stop} = await startTestService({
      // a short verify budget: the failed melt is classified by the poll
      // running out, and that wait is the test's own clock
      poll: {intervalMs: 10, intervalCapMs: 20, maxWaitMs: 300},
    })
    state.bearers = [await makeBearer(m, '01'.repeat(32), 21_000)]

    const response = await call(relay, walletServicePubkey, 'pay_invoice', {
      invoice: 'lnbc210n1pjqrstuvwxyz',
    })
    expect(response.error?.code).toBe('PAYMENT_FAILED')

    // the funds came back, re-secured: the old secret burned, a fresh one
    // tracked unspent via the changeset - and no budget spend recorded
    expect(m.state.noteState('01'.repeat(32))).toBe('burned')
    const returned = requiredValue(state.bearers.find((b) => b.id.startsWith('added-')))
    expect(returned.spent).toBeUndefined()
    expect(returned.amount).toBe(21_000)
    expect(m.state.noteState(requiredValue(noteK1(returned.url)))).toBe('outstanding')
    expect(requiredValue(readNwcConnections(OWNER_ID)[0]).spent.msat).toBe(0)
    await stop()
  })
})
