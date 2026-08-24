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
describe('service: request validation', () => {
  it('answers an unknown method with NOT_IMPLEMENTED', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const response = await call(relay, walletServicePubkey, 'get_payments', {})
    expect(response.result_type).toBe('get_payments')
    expect(response.error?.code).toBe('NOT_IMPLEMENTED')
    expect(response.result).toBeNull()
    await stop()
  })

  it('answers a malformed (non-JSON) request with an error, not a crash', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const request = clientRequest(walletServicePubkey, 'this is not json')
    relay.emit(request)
    await waitFor(() => readResponse(relay.published, request.id, 'nip44_v2') !== null)
    const response = requiredValue(readResponse(relay.published, request.id, 'nip44_v2'))
    expect(response.error?.code).toBe('OTHER')
    await stop()
  })

  it('answers a JSON request without a method with an error', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const request = clientRequest(walletServicePubkey, JSON.stringify({params: {}}))
    relay.emit(request)
    await waitFor(() => readResponse(relay.published, request.id, 'nip44_v2') !== null)
    expect(requiredValue(readResponse(relay.published, request.id, 'nip44_v2')).error?.code).toBe(
      'OTHER',
    )
    await stop()
  })

  it('ignores a request signed by a stranger key - silently', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const content = nip44v2.encrypt(
      JSON.stringify({method: 'get_balance', params: {}}),
      nip44v2.utils.getConversationKey(STRANGER_SECRET, walletServicePubkey),
    )
    const forged = finalizeEvent(
      {
        kind: NWC_REQUEST_KIND,
        created_at: nowSeconds(),
        tags: [
          ['p', walletServicePubkey],
          ['encryption', 'nip44_v2'],
        ],
        content,
      },
      STRANGER_SECRET,
    )
    relay.emit(forged)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(relay.published.filter((e) => e.kind === NWC_RESPONSE_KIND)).toHaveLength(0)
    await stop()
  })

  it('answers an unsupported encryption scheme with UNSUPPORTED_ENCRYPTION', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const content = nip04Encrypt(
      CLIENT_SECRET,
      walletServicePubkey,
      JSON.stringify({method: 'get_balance', params: {}}),
    )
    const request = finalizeEvent(
      {
        kind: NWC_REQUEST_KIND,
        created_at: nowSeconds(),
        tags: [
          ['p', walletServicePubkey],
          ['encryption', 'nip17'],
        ],
        content,
      },
      CLIENT_SECRET,
    )
    relay.emit(request)
    // the error answer goes out in the legacy scheme every client reads
    await waitFor(() => readResponse(relay.published, request.id, 'nip04') !== null)
    expect(requiredValue(readResponse(relay.published, request.id, 'nip04')).error?.code).toBe(
      'UNSUPPORTED_ENCRYPTION',
    )
    await stop()
  })

  it('speaks legacy NIP-04: no encryption tag, and an explicit nip04 tag', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    for (const scheme of ['none', 'nip04'] as const) {
      const request = methodRequest(walletServicePubkey, 'get_balance', {}, scheme)
      relay.emit(request)
      await waitFor(() => readResponse(relay.published, request.id, 'nip04') !== null)
      const response = requiredValue(readResponse(relay.published, request.id, 'nip04'))
      expect(response.error).toBeNull()
      expect(response.result).toEqual({balance: 0})
      // the response mirrors the request's scheme
      const event = requiredValue(
        relay.published.find(
          (e) =>
            e.kind === NWC_RESPONSE_KIND && e.tags.some((t) => t[0] === 'e' && t[1] === request.id),
        ),
      )
      expect(event.tags).toContainEqual(['encryption', 'nip04'])
    }
    await stop()
  })

  it('drops requests older than the replay window unanswered', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const stale = methodRequest(
      walletServicePubkey,
      'get_balance',
      {},
      'nip44_v2',
      nowSeconds() - 1200,
    )
    relay.emit(stale)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(relay.published.filter((e) => e.kind === NWC_RESPONSE_KIND)).toHaveLength(0)
    await stop()
  })

  it('picks up no new requests after stop', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    await stop()
    const request = methodRequest(walletServicePubkey, 'get_balance', {})
    relay.emitAfterClose(request)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(relay.published.filter((e) => e.kind === NWC_RESPONSE_KIND)).toHaveLength(0)
  })
})
