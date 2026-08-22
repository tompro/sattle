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
describe('storage validation', () => {
  it('drops malformed records instead of throwing', () => {
    localStorage.setItem(
      'sattle_nwc_connections',
      JSON.stringify([
        {clientPubkey: 'nope'},
        {
          version: 1,
          ownerId: OWNER_ID,
          clientPubkey: CLIENT_PUBKEY,
          relays: RELAYS,
          budget: {maxMsat: 1000, periodMs: 1000},
          spent: {periodStart: 0, msat: 0},
          createdAt: 0,
        },
      ]),
    )
    expect(readNwcConnections(OWNER_ID)).toHaveLength(1)
    expect(requiredValue(readNwcConnections(OWNER_ID)[0]).clientPubkey).toBe(CLIENT_PUBKEY)
  })

  it('returns nothing for garbage json', () => {
    localStorage.setItem('sattle_nwc_connections', '{{{')
    expect(readNwcConnections(OWNER_ID)).toEqual([])
  })

  it('returns only strictly parsed records belonging to the requested owner', () => {
    const current = createConnection(LINKING_KEY, {
      relays: RELAYS,
      budget: {maxMsat: 1000, periodMs: 1000},
      clientSecret: CLIENT_SECRET,
      now: 10,
    }).record
    const foreign = foreignConnectionFixture({maxMsat: 2000, periodMs: 2000}, 20).record
    const raw: unknown = JSON.parse(localStorage.getItem('sattle_nwc_connections') ?? '[]')
    if (!Array.isArray(raw)) throw new TypeError('Expected stored NWC records')
    localStorage.setItem(
      'sattle_nwc_connections',
      JSON.stringify([
        ...raw,
        foreign,
        {...current, ownerId: 'malformed'},
        {
          clientPubkey: getPublicKey(hexToBytes('33'.repeat(32))),
          relays: RELAYS,
          budget: {maxMsat: 3000, periodMs: 3000},
          spent: {periodStart: 0, msat: 0},
          createdAt: 30,
        },
      ]),
    )

    expect(readNwcConnections(OWNER_ID)).toEqual([current])
    expect(readNwcConnections(OTHER_OWNER_ID)).toEqual([foreign])
  })

  it('adopts ownerless connections and enabled state only after owner proof', async () => {
    await saveLinkingKey(LINKING_KEY)
    const saved: unknown = JSON.parse(localStorage.getItem('sattle_linking_key') ?? '{}')
    if (typeof saved !== 'object' || saved === null) {
      throw new TypeError('Expected a saved linking-key record')
    }
    Reflect.deleteProperty(saved, 'ownerId')
    Reflect.deleteProperty(saved, 'version')
    localStorage.setItem('sattle_linking_key', JSON.stringify(saved))
    localStorage.setItem(
      'sattle_nwc_connections',
      JSON.stringify([
        {
          clientPubkey: CLIENT_PUBKEY,
          relays: RELAYS,
          budget: {maxMsat: 1000, periodMs: 1000},
          spent: {periodStart: 0, msat: 0},
          createdAt: 0,
        },
      ]),
    )
    localStorage.setItem('sattle_nwc_enabled', 'true')

    expect(() => migrateLegacyNwcStorage(LINKING_KEY)).toThrow()
    expect(readNwcConnections(OWNER_ID)).toEqual([])
    expect(readNwcEnabled(OWNER_ID)).toBe(false)

    ensureSavedKeyOwner(LINKING_KEY)
    expect(migrateLegacyNwcStorage(LINKING_KEY)).toEqual({
      connections: 1,
      enabled: true,
    })
    expect(readNwcConnections(OWNER_ID)).toHaveLength(1)
    expect(readNwcEnabled(OWNER_ID)).toBe(true)
    expect(migrateLegacyNwcStorage(LINKING_KEY)).toEqual({
      connections: 0,
      enabled: false,
    })
  })

  it('does not expose one wallet enabled state to another owner', () => {
    writeNwcEnabled(OWNER_ID, true)

    expect(readNwcEnabled(OWNER_ID)).toBe(true)
    expect(readNwcEnabled(OTHER_OWNER_ID)).toBe(false)
  })

  it('treats malformed owner-bearing enabled records as disabled', () => {
    for (const value of [
      {version: 1, ownerId: 'malformed', enabled: true},
      {version: 2, ownerId: OWNER_ID, enabled: true},
      {version: 1, ownerId: OWNER_ID, enabled: 'true'},
    ]) {
      localStorage.setItem('sattle_nwc_enabled', JSON.stringify(value))
      expect(readNwcEnabled(OWNER_ID)).toBe(false)
    }
  })
})
