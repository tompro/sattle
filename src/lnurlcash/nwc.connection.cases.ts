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
describe('connection strings', () => {
  it('round-trips build -> parse, including several relays', () => {
    const uri = buildConnectionString('ab'.repeat(32), 'cd'.repeat(32), [
      'wss://relay-a.example',
      'wss://relay-b.example/path?q=1',
    ])
    expect(uri).toBe(
      `nostr+walletconnect://${'ab'.repeat(32)}?relay=${encodeURIComponent('wss://relay-a.example')}&relay=${encodeURIComponent('wss://relay-b.example/path?q=1')}&secret=${'cd'.repeat(32)}`,
    )
    expect(parseConnectionString(uri)).toEqual({
      walletServicePubkey: 'ab'.repeat(32),
      clientSecret: 'cd'.repeat(32),
      relays: ['wss://relay-a.example', 'wss://relay-b.example/path?q=1'],
    })
  })

  it('rejects strings that are not connection strings', () => {
    expect(parseConnectionString('not a uri')).toBeNull()
    expect(parseConnectionString('https://example.com')).toBeNull()
    // missing secret
    expect(
      parseConnectionString(`nostr+walletconnect://${'ab'.repeat(32)}?relay=wss%3A%2F%2Fr.example`),
    ).toBeNull()
    // missing relay
    expect(
      parseConnectionString(`nostr+walletconnect://${'ab'.repeat(32)}?secret=${'cd'.repeat(32)}`),
    ).toBeNull()
    // a non-hex pubkey
    expect(
      parseConnectionString(
        'nostr+walletconnect://zzzz?relay=wss%3A%2F%2Fr.example&secret=' + 'cd'.repeat(32),
      ),
    ).toBeNull()
  })

  it('createConnection returns a string that parses back to the same connection', () => {
    const connection = createConnection(LINKING_KEY, {
      relays: RELAYS,
      budget: {maxMsat: 100_000, periodMs: 86_400_000},
      clientSecret: CLIENT_SECRET,
    })
    const parsed = parseConnectionString(connection.connectionString)
    expect(parsed).toEqual({
      walletServicePubkey: connection.walletServicePubkey,
      clientSecret: '11'.repeat(32),
      relays: RELAYS,
    })
    // the record persisted WITHOUT the client secret - it is handed out
    // once, in the connection string, and never stored
    const records = readNwcConnections(OWNER_ID)
    expect(records).toHaveLength(1)
    expect(requiredValue(records[0]).clientPubkey).toBe(CLIENT_PUBKEY)
    expect(JSON.stringify(records[0])).not.toContain('11'.repeat(32))
  })
})

describe('deriveNwcWalletKey', () => {
  it('is pinned: derivation changes would silently orphan every connection', () => {
    expect(bytesToHex(deriveNwcWalletKey(LINKING_KEY, CLIENT_PUBKEY))).toBe(
      '71428fc3d77c75f9dc70037283fbed5407cecc44eab56873986a33c24c3e034d',
    )
    expect(getPublicKey(deriveNwcWalletKey(LINKING_KEY, CLIENT_PUBKEY))).toBe(
      'bf02224dc973a24466ded285c24fb5baf78352b0a2364de7a15b0263fc048bcf',
    )
  })

  it('derives a distinct key per client and per linking key', () => {
    const base = bytesToHex(deriveNwcWalletKey(LINKING_KEY, CLIENT_PUBKEY))
    expect(bytesToHex(deriveNwcWalletKey(LINKING_KEY, getPublicKey(STRANGER_SECRET)))).not.toBe(
      base,
    )
    expect(bytesToHex(deriveNwcWalletKey(OTHER_LINKING_KEY, CLIENT_PUBKEY))).not.toBe(base)
  })

  it('re-derives the same wallet identity from a persisted record after a reinstall', () => {
    const first = createConnection(LINKING_KEY, {
      relays: RELAYS,
      budget: {maxMsat: 100_000, periodMs: 86_400_000},
      clientSecret: CLIENT_SECRET,
    })
    expect(first.walletServicePubkey).toBe(
      'bf02224dc973a24466ded285c24fb5baf78352b0a2364de7a15b0263fc048bcf',
    )
  })
})
