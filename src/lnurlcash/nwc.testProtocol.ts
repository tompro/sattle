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

export const LINKING_KEY = new Uint8Array(32).fill(7)
export const OTHER_LINKING_KEY = new Uint8Array(32).fill(9)
export const CLIENT_SECRET = hexToBytes('11'.repeat(32))
export const CLIENT_PUBKEY = getPublicKey(CLIENT_SECRET)
export const STRANGER_SECRET = hexToBytes('22'.repeat(32))
export const OWNER_ID = linkingPubKeyHex(LINKING_KEY)
export const OTHER_OWNER_ID = linkingPubKeyHex(OTHER_LINKING_KEY)

// never connected - the in-memory relay below stands in
export const RELAYS = ['wss://relay-a.example']

let NOW = 1_800_000_000
export const nowSeconds = (): number => NOW

export const FAST_POLL = {intervalMs: 10, intervalCapMs: 50, maxWaitMs: 5_000}

export const foreignConnectionFixture = (budget: NwcConnectionRecord['budget'], now: number) =>
  connectionInfoOf(OTHER_LINKING_KEY, {
    version: 1,
    ownerId: OTHER_OWNER_ID,
    clientPubkey: getPublicKey(STRANGER_SECRET),
    relays: RELAYS,
    budget,
    spent: {periodStart: now, msat: 0},
    createdAt: now,
  })

export const storeForeignConnection = (record: NwcConnectionRecord): void => {
  const raw: unknown = JSON.parse(localStorage.getItem('sattle_nwc_connections') ?? '[]')
  if (!Array.isArray(raw)) throw new TypeError('Expected stored NWC records')
  localStorage.setItem('sattle_nwc_connections', JSON.stringify([...raw, record]))
}

// an in-memory relay set: subscriptions register, emit delivers to every
// matching one, publish records
export const createFakeRelay = (): {
  transport: NwcTransport
  published: NostrEvent[]
  emit: (event: NostrEvent) => void
  emitAfterClose: (event: NostrEvent) => void
  subscriptionCount: () => number
} => {
  const published: NostrEvent[] = []
  const subs: {filter: NostrFilter; onEvent: (event: NostrEvent) => void}[] = []
  const allSubs: {filter: NostrFilter; onEvent: (event: NostrEvent) => void}[] = []
  const transport: NwcTransport = {
    publish: (_relays, event) => {
      published.push(event)
      return Promise.resolve()
    },
    subscribe: (_relays, filter, onEvent) => {
      const sub = {filter, onEvent}
      subs.push(sub)
      allSubs.push(sub)
      return {
        close: () => {
          const index = subs.indexOf(sub)
          if (index >= 0) subs.splice(index, 1)
        },
      }
    },
  }
  const deliver = (
    targets: {filter: NostrFilter; onEvent: (event: NostrEvent) => void}[],
    event: NostrEvent,
  ): void => {
    for (const sub of [...targets]) {
      const kindsMatch = !sub.filter.kinds || sub.filter.kinds.includes(event.kind)
      const wanted = sub.filter['#p']
      const pMatch = !wanted || event.tags.some((t) => t[0] === 'p' && wanted.includes(t[1] ?? ''))
      const sinceMatch = sub.filter.since === undefined || event.created_at >= sub.filter.since
      if (kindsMatch && pMatch && sinceMatch) sub.onEvent(event)
    }
  }
  const emit = (event: NostrEvent): void => deliver(subs, event)
  const emitAfterClose = (event: NostrEvent): void => deliver(allSubs, event)
  return {
    transport,
    published,
    emit,
    emitAfterClose,
    subscriptionCount: () => subs.length,
  }
}

export type Encryption = 'nip44_v2' | 'nip04' | 'none'

// a NIP-47 request exactly as a real client would build it, signed by the
// connection's client secret
export const clientRequest = (
  walletServicePubkey: string,
  content: string,
  scheme: Encryption = 'nip44_v2',
  createdAt: number = NOW,
): NostrEvent => {
  const tags: string[][] = [['p', walletServicePubkey]]
  if (scheme !== 'none') tags.push(['encryption', scheme])
  return finalizeEvent(
    {
      kind: NWC_REQUEST_KIND,
      created_at: createdAt,
      tags,
      content:
        scheme === 'nip44_v2'
          ? nip44v2.encrypt(
              content,
              nip44v2.utils.getConversationKey(CLIENT_SECRET, walletServicePubkey),
            )
          : nip04Encrypt(CLIENT_SECRET, walletServicePubkey, content),
    },
    CLIENT_SECRET,
  )
}

export const methodRequest = (
  walletServicePubkey: string,
  method: string,
  params: Record<string, unknown>,
  scheme: Encryption = 'nip44_v2',
  createdAt?: number,
): NostrEvent =>
  clientRequest(walletServicePubkey, JSON.stringify({method, params}), scheme, createdAt)

// generous: a failed/never-settling melt is only classified after the
// verify-poll budget (seconds) runs out
export const waitFor = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 3000 && !cond(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(cond()).toBe(true)
}

export const deferred = (): {
  promise: Promise<void>
  resolve: () => void
  reject: (reason: Error) => void
} => {
  let resolve = (): void => undefined
  let reject = (_reason: Error): void => undefined
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return {promise, resolve, reject}
}

export const resetNow = (): void => {
  NOW = 1_800_000_000
}
