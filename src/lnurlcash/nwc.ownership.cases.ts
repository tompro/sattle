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
describe('service ownership', () => {
  it('subscribes only current-owner records and leaves foreign budgets untouched', async () => {
    const current = createConnection(LINKING_KEY, {
      relays: RELAYS,
      budget: {maxMsat: 1000, periodMs: 1000},
      clientSecret: CLIENT_SECRET,
      now: 0,
    })
    const foreign = foreignConnectionFixture({maxMsat: 2000, periodMs: 2000}, 0)
    storeForeignConnection(foreign.record)
    const relay = createFakeRelay()

    const service = await startService(LINKING_KEY, {
      assertCurrentOwner: () => undefined,
      getBearers: () => [],
      getDefaultMint: () => null,
      applyChangeset: () => Promise.resolve(),
      transport: relay.transport,
      nowSeconds,
    })

    expect(service.connections.map((connection) => connection.record)).toEqual([current.record])
    expect(relay.subscriptionCount()).toBe(1)
    expect(readNwcConnections(OTHER_OWNER_ID)[0]?.spent.msat).toBe(0)
    expect(service.connections).not.toContainEqual(foreign)
    await service.stop()
  })

  it('ignores foreign records handed in through the records snapshot', async () => {
    // the injected-records path bypasses storage, so the service's own
    // owner filter is the only boundary here (stale-ownership probe: a
    // snapshot from a previous wallet must not be served)
    const current = createConnection(LINKING_KEY, {
      relays: RELAYS,
      budget: {maxMsat: 1000, periodMs: 1000},
      clientSecret: CLIENT_SECRET,
      now: 0,
    })
    const foreign = foreignConnectionFixture({maxMsat: 2000, periodMs: 2000}, 0)
    const relay = createFakeRelay()

    const service = await startService(
      LINKING_KEY,
      {
        assertCurrentOwner: () => undefined,
        getBearers: () => [],
        getDefaultMint: () => null,
        applyChangeset: () => Promise.resolve(),
        transport: relay.transport,
        nowSeconds,
      },
      [current.record, foreign.record],
    )

    expect(service.connections.map((connection) => connection.record)).toEqual([current.record])
    expect(relay.subscriptionCount()).toBe(1)
    // the foreign snapshot record must not be persisted for the new owner
    expect(readNwcConnections(OWNER_ID)).toEqual([current.record])
    await service.stop()
  })
})

describe('service: info and balance', () => {
  it('publishes a kind-13194 info event on startup', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const info = requiredValue(relay.published.find((e) => e.kind === NWC_INFO_KIND))
    expect(info.pubkey).toBe(walletServicePubkey)
    expect(info.content).toContain('pay_invoice')
    expect(info.content).toContain('make_invoice')
    expect(info.tags).toContainEqual(['encryption', 'nip44_v2 nip04'])
    await stop()
  })

  it('answers get_info with the connection identity and method list', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const response = await call(relay, walletServicePubkey, 'get_info', {})
    expect(response.error).toBeNull()
    expect(response.result_type).toBe('get_info')
    expect(response.result).toMatchObject({
      alias: 'sattle',
      pubkey: walletServicePubkey,
      methods: ['get_info', 'get_balance', 'make_invoice', 'pay_invoice', 'lookup_invoice'],
    })
    await stop()
  })

  it('answers get_balance with the spendable total only', async () => {
    const m = await mint()
    const {relay, walletServicePubkey, state, stop} = await startTestService({})
    state.bearers = [
      await makeBearer(m, 'aa'.repeat(32), 21_000),
      await makeBearer(m, 'bb'.repeat(32), 5_000),
      {...(await makeBearer(m, 'cc'.repeat(32), 99_000)), spent: true},
    ]
    const response = await call(relay, walletServicePubkey, 'get_balance', {})
    expect(response.error).toBeNull()
    expect(response.result).toEqual({balance: 26_000})
    await stop()
  })
})
