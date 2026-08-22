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
describe('service: pay_invoice', () => {
  it('applies the settled changeset before publishing success', async () => {
    const m = await mint()
    const {relay, walletServicePubkey, state, stop} = await startTestService({})
    state.bearers = [await makeBearer(m, 'dc'.repeat(32), 21_000)]

    const response = await call(relay, walletServicePubkey, 'pay_invoice', {
      invoice: 'lnbc210n1pjqrstuvwxyz',
    })

    expect(response.error).toBeNull()
    expect(state.changesets).toHaveLength(1)
    expect(state.bearers[0]?.spent).toBe(true)
    await stop()
  })

  it('pays a bolt11 by melting, returning the melt preimage and recording the spend', async () => {
    const m = await mint()
    const {relay, walletServicePubkey, state, stop} = await startTestService({
      budgetMsat: 50_000,
    })
    const foreign = foreignConnectionFixture(
      {maxMsat: 99_000, periodMs: 86_400_000},
      nowSeconds() * 1000,
    )
    storeForeignConnection(foreign.record)
    state.bearers = [await makeBearer(m, 'dd'.repeat(32), 21_000)]

    const response = await call(relay, walletServicePubkey, 'pay_invoice', {
      invoice: 'lnbc210n1pjqrstuvwxyz',
    })
    expect(response.error).toBeNull()
    expect(requiredString(response.result?.preimage)).toHaveLength(64)

    // the note is gone (melted) and locked spent via the changeset
    expect(m.state.noteState('dd'.repeat(32))).toBe('burned')
    expect(requiredValue(state.bearers[0]).spent).toBe(true)

    // the spend was recorded against the budget, persisted
    expect(readNwcConnections(OWNER_ID)[0]?.spent.msat).toBe(21_000)
    expect(readNwcConnections(OTHER_OWNER_ID)[0]?.spent.msat).toBe(0)
    await stop()
  })

  it('waits for a deferred bearer commit before publishing payment success', async () => {
    const m = await mint()
    const commit = deferred()
    let commitStarted = false
    const {relay, walletServicePubkey, state, stop} = await startTestService({
      commitChangeset: () => {
        commitStarted = true
        return commit.promise
      },
    })
    state.bearers = [await makeBearer(m, 'db'.repeat(32), 21_000)]
    const request = methodRequest(walletServicePubkey, 'pay_invoice', {
      invoice: 'lnbc210n1pjqrstuvwxyz',
    })

    relay.emit(request)
    await waitFor(() => commitStarted)

    // a non-awaiting engine publishes within milliseconds of the commit
    // call (one local verify re-read + encrypt); this window is far wider
    // than that, so an early response here can only mean a missing barrier
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(readResponse(relay.published, request.id, 'nip44_v2')).toBeNull()
    commit.resolve()
    await waitFor(() => readResponse(relay.published, request.id, 'nip44_v2') !== null)
    expect(readResponse(relay.published, request.id, 'nip44_v2')?.error).toBeNull()
    await stop()
  })

  it('reports a rejected bearer commit without publishing payment success', async () => {
    const m = await mint()
    const commit = deferred()
    const commitError = new Error('bearer commit failed')
    let commitStarted = false
    const {relay, walletServicePubkey, state, stop} = await startTestService({
      commitChangeset: () => {
        commitStarted = true
        return commit.promise
      },
    })
    state.bearers = [await makeBearer(m, 'da'.repeat(32), 21_000)]
    const request = methodRequest(walletServicePubkey, 'pay_invoice', {
      invoice: 'lnbc210n1pjqrstuvwxyz',
    })

    relay.emit(request)
    await waitFor(() => commitStarted)
    commit.reject(commitError)
    await waitFor(
      () =>
        state.errors.length > 0 || readResponse(relay.published, request.id, 'nip44_v2') !== null,
    )

    expect(readResponse(relay.published, request.id, 'nip44_v2')).toBeNull()
    expect(state.errors).toEqual([commitError])
    // the conservative budget debit is persisted separately from bearer
    // storage and deliberately NOT rolled back: the budget was debited,
    // the bearer was never locked spent
    expect(requiredValue(readNwcConnections(OWNER_ID)[0]).spent.msat).toBe(21_000)
    expect(state.bearers[0]?.spent).toBeUndefined()
    await stop()
  })

  it('drains an in-flight pay across repeated stops once its deferred commit resolves', async () => {
    const m = await mint()
    const commit = deferred()
    let commitStarted = false
    const {relay, walletServicePubkey, state, stop} = await startTestService({
      commitChangeset: () => {
        commitStarted = true
        return commit.promise
      },
    })
    state.bearers = [await makeBearer(m, 'd9'.repeat(32), 21_000)]
    const request = methodRequest(walletServicePubkey, 'pay_invoice', {
      invoice: 'lnbc210n1pjqrstuvwxyz',
    })

    relay.emit(request)
    await waitFor(() => commitStarted)
    // stop closes subscriptions; in-flight handlers still finish (their
    // changesets hold money) - a repeated stop interrupts nothing twice
    let stopped = false
    const firstStop = stop().then(() => {
      stopped = true
    })
    const repeatedStop = stop()
    await Promise.resolve()
    expect(stopped).toBe(false)
    // subscriptions close IMMEDIATELY, before the drain completes
    expect(relay.subscriptionCount()).toBe(0)

    const afterStop = methodRequest(walletServicePubkey, 'get_balance', {})
    relay.emitAfterClose(afterStop)
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(readResponse(relay.published, afterStop.id, 'nip44_v2')).toBeNull()

    commit.resolve()
    await Promise.all([firstStop, repeatedStop])
    expect(readResponse(relay.published, request.id, 'nip44_v2')?.error).toBeNull()
    expect(state.bearers[0]?.spent).toBe(true)
  })

  it('rejects a stale saved owner before touching the mint', async () => {
    const m = await mint()
    const {relay, walletServicePubkey, state, stop} = await startTestService({})
    state.bearers = [await makeBearer(m, 'd8'.repeat(32), 21_000)]
    localStorage.setItem(
      'sattle_linking_key',
      JSON.stringify({
        enc: false,
        value: bytesToHex(OTHER_LINKING_KEY),
        ownerId: OTHER_OWNER_ID,
        version: 1,
      }),
    )
    const request = methodRequest(walletServicePubkey, 'pay_invoice', {
      invoice: 'lnbc210n1pjqrstuvwxyz',
    })

    relay.emit(request)
    await waitFor(
      () =>
        state.errors.length > 0 || readResponse(relay.published, request.id, 'nip44_v2') !== null,
    )

    expect(m.state.noteState('d8'.repeat(32))).toBe('outstanding')
    expect(state.changesets).toEqual([])
    expect(readResponse(relay.published, request.id, 'nip44_v2')?.error?.code).toBe('INTERNAL')
    await stop()
  })
})
