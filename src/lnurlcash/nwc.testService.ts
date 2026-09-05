// The NWC wallet service end to end: connection strings and key
// derivation, the request/response cycle over an in-memory relay (the
// transport is injected - no network), every method against the
// conformance mock mint, the legacy NIP-04 path, budget enforcement, and
// the error paths. Fund-safety focus: budgets can't be exceeded, stale
// requests never execute, and a settled preimage only ever reveals an
// already-rotated (burned) note secret.

import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {finalizeEvent, getPublicKey} from 'nostr-tools/pure'
import {encrypt as nip04Encrypt, decrypt as nip04Decrypt} from 'nostr-tools/nip04'
import {v2 as nip44v2} from 'nostr-tools/nip44'
import {buildNoteUrl, fetchNoteInfo, noteK1, serverOf} from 'lnurlcash-kit'
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
import {isJsonObject} from './jsonParsing'

import {
  CLIENT_SECRET,
  FAST_POLL,
  LINKING_KEY,
  OWNER_ID,
  RELAYS,
  createFakeRelay,
  methodRequest,
  nowSeconds,
  resetNow,
  waitFor,
} from './nwc.testProtocol'
import type {Encryption} from './nwc.testProtocol'
export type NwcResponsePayload = {
  result_type: string
  error: {code: string; message: string} | null
  result: Record<string, unknown> | null
}

const isNwcResponsePayload = (value: unknown): value is NwcResponsePayload =>
  isJsonObject(value) &&
  typeof value.result_type === 'string' &&
  (value.error === null ||
    (isJsonObject(value.error) &&
      typeof value.error.code === 'string' &&
      typeof value.error.message === 'string')) &&
  (value.result === null || isJsonObject(value.result))

export const readResponse = (
  published: NostrEvent[],
  requestId: string,
  scheme: Encryption,
): NwcResponsePayload | null => {
  const event = published.find(
    (e) => e.kind === NWC_RESPONSE_KIND && e.tags.some((t) => t[0] === 'e' && t[1] === requestId),
  )
  if (!event) return null
  const plaintext =
    scheme === 'nip44_v2'
      ? nip44v2.decrypt(
          event.content,
          nip44v2.utils.getConversationKey(CLIENT_SECRET, event.pubkey),
        )
      : nip04Decrypt(CLIENT_SECRET, event.pubkey, event.content)
  const parsed: unknown = JSON.parse(plaintext)
  if (!isNwcResponsePayload(parsed)) throw new TypeError('Expected a valid NWC response payload.')
  return parsed
}

// drives one full request/response round trip over the fake relay
export const call = async (
  relay: ReturnType<typeof createFakeRelay>,
  walletServicePubkey: string,
  method: string,
  params: Record<string, unknown>,
  scheme: Encryption = 'nip44_v2',
): Promise<NwcResponsePayload> => {
  const request = methodRequest(walletServicePubkey, method, params, scheme)
  relay.emit(request)
  await waitFor(() => readResponse(relay.published, request.id, scheme) !== null)
  return requiredValue(readResponse(relay.published, request.id, scheme))
}

export type Mint = Awaited<ReturnType<typeof createMockMint>>
const mints: Mint[] = []
export const mint = async (options: Parameters<typeof createMockMint>[0] = {}): Promise<Mint> => {
  const m = await createMockMint(options)
  mints.push(m)
  return m
}

afterEach(async () => {
  await Promise.all(mints.splice(0).map((m) => m.close()))
})

let bearerCounter = 0
let allocationCounter = 0
export const makeBearer = async (m: Mint, k1: string, amountMsat: number): Promise<Bearer> => {
  m.state.creditNote(k1, amountMsat)
  const url = buildNoteUrl(`${m.url}/w`, k1, amountMsat)
  const info = await fetchNoteInfo(url)
  bearerCounter += 1
  return {
    id: `bearer-${bearerCounter}`,
    url,
    callback: info.callback,
    amount: info.maxWithdrawable,
    verified: true,
    mintPubkey: m.state.pubkey,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

// the harness around startService: a fake relay, an in-memory "store"
// applying changesets the way the Pinia layer will, and a created
// connection with a pinned client secret
export const startTestService = async (options: {
  budgetMsat?: number
  periodMs?: number
  defaultMint?: string | null
  linkingKey?: Uint8Array
  poll?: typeof FAST_POLL
  claimPoll?: typeof FAST_POLL
  kit?: NwcServiceDeps['kit']
  commitChangeset?: (changeset: NwcChangeset) => Promise<void>
  setMintOutputRetirement?: () => Promise<void>
}): Promise<{
  relay: ReturnType<typeof createFakeRelay>
  walletServicePubkey: string
  state: {bearers: Bearer[]; changesets: NwcChangeset[]; errors: unknown[]}
  stop: () => Promise<void>
}> => {
  const budgetMsat = options.budgetMsat ?? 1_000_000_000
  const connection = createConnection(options.linkingKey ?? LINKING_KEY, {
    relays: RELAYS,
    budget: {maxMsat: budgetMsat, periodMs: options.periodMs ?? 86_400_000},
    clientSecret: CLIENT_SECRET,
    now: nowSeconds() * 1000,
  })
  const relay = createFakeRelay()
  const state: {bearers: Bearer[]; changesets: NwcChangeset[]; errors: unknown[]} = {
    bearers: [],
    changesets: [],
    errors: [],
  }
  const service = await startService(options.linkingKey ?? LINKING_KEY, {
    assertCurrentOwner: () => undefined,
    // deterministic stand-in for the wallet's BIP-32 allocation path
    allocateOutputSecrets: (_server, count) => {
      const secrets = Array.from({length: count}, () => {
        allocationCounter += 1
        return bytesToHex(sha256(utf8ToBytes(`nwc-test-allocation-${allocationCounter}`)))
      })
      return Promise.resolve(secrets)
    },
    // the keys a production caller serves from the trusted-mint registry:
    // each created mock mint's current key plus any it retired
    mintSignatureKeys: (server) =>
      mints.flatMap((m) =>
        new URL(m.url).host === server ? [m.state.pubkey, ...m.state.previousPubkeys] : [],
      ),
    recoverPendingMints: () => Promise.resolve(),
    getBearers: () => state.bearers,
    getDefaultMint: () => options.defaultMint ?? null,
    persistMintOutput: (note) => {
      bearerCounter += 1
      const bearer: Bearer = {
        ...note,
        id: `staged-${bearerCounter}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      state.bearers.push(bearer)
      return Promise.resolve(bearer)
    },
    discardMintOutput: (staged) => {
      state.bearers = state.bearers.filter((bearer) => bearer.id !== staged.id)
      return Promise.resolve()
    },
    setMintOutputRetirement: (staged, retireAfter) => {
      const override = options.setMintOutputRetirement?.()
      if (override) return override
      const index = state.bearers.findIndex((bearer) => bearer.id === staged.id)
      if (index < 0) return Promise.reject(new Error('The staged bearer is missing.'))
      const updated: Bearer = {
        ...staged,
        pendingMint: {...staged.pendingMint, retireAfter},
        updatedAt: Date.now(),
      }
      state.bearers[index] = updated
      return Promise.resolve()
    },
    reserveMintOutputSource: (staged, sourceId, recoverySecret) => {
      const index = state.bearers.findIndex((bearer) => bearer.id === staged.id)
      const source = state.bearers.find((bearer) => bearer.id === sourceId)
      if (index < 0 || !source) return Promise.reject(new Error('The payment journal is missing.'))
      source.spent = true
      state.bearers[index] = {
        ...state.bearers[index]!,
        pendingMint: {
          ...state.bearers[index]!.pendingMint,
          sourceBearerId: sourceId,
          sourceRecoverySecret: recoverySecret,
        },
      }
      return Promise.resolve()
    },
    finalizeMintOutput: async (staged, note) => {
      const changeset: NwcChangeset = {add: [], markSpent: []}
      await options.commitChangeset?.(changeset)
      state.changesets.push(changeset)
      const index = state.bearers.findIndex((bearer) => bearer.id === staged.id)
      if (index < 0) throw new Error('The staged bearer is missing.')
      state.bearers[index] = {...staged, ...note, pendingMint: undefined, updatedAt: Date.now()}
    },
    finalizePaymentReturn: async (staged, note) => {
      const index = state.bearers.findIndex((bearer) => bearer.id === staged.id)
      if (index < 0) throw new Error('The staged bearer is missing.')
      const sourceId = state.bearers[index]?.pendingMint?.sourceBearerId
      if (sourceId) {
        const source = state.bearers.find((bearer) => bearer.id === sourceId)
        if (source) source.spent = true
      }
      state.bearers[index] = {...state.bearers[index]!, ...note, pendingMint: undefined, updatedAt: Date.now()}
    },
    finalizeSpentMintOutput: (staged) => {
      state.bearers = state.bearers.filter((bearer) => bearer.id !== staged.id)
      return Promise.resolve()
    },
    commitCarve: async (carve) => {
      // a checkpoint is identified by its output secret: the landed phase's
      // URL carries a signature the staged phase's did not have yet
      const sameOutput = (url: string, noteUrl: string): boolean =>
        serverOf(url) === serverOf(noteUrl) &&
        noteK1(url) !== null &&
        noteK1(url) === noteK1(noteUrl)
      const additions = [carve.note, ...(carve.change ? [carve.change] : [])].filter(
        (note) => !state.bearers.some((bearer) => sameOutput(bearer.url, note.url)),
      )
      const changeset: NwcChangeset = {
        add: additions,
        markSpent: carve.consumed.map((bearer) => bearer.id),
      }
      await options.commitChangeset?.(changeset)
      state.changesets.push(changeset)
      for (const bearer of state.bearers) {
        if (changeset.markSpent.includes(bearer.id)) bearer.spent = true
      }
      for (const note of additions) {
        bearerCounter += 1
        state.bearers.unshift({
          ...note,
          id: `carve-${bearerCounter}`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      }
      const committed = state.bearers.find((bearer) => sameOutput(bearer.url, carve.note.url))
      if (!committed) throw new Error('The carved note was not committed.')
      return committed
    },
    applyChangeset: async (changeset: NwcChangeset) => {
      await options.commitChangeset?.(changeset)
      state.changesets.push(changeset)
      for (const id of changeset.markSpent) {
        const bearer = state.bearers.find((b) => b.id === id)
        if (bearer) bearer.spent = true
      }
      for (const note of changeset.add) {
        bearerCounter += 1
        state.bearers.push({
          ...note,
          id: `added-${bearerCounter}`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      }
    },
    onError: (err) => {
      state.errors.push(err)
    },
    transport: relay.transport,
    kit: options.kit,
    poll: options.poll ?? FAST_POLL,
    claimPoll: options.claimPoll ?? FAST_POLL,
    nowSeconds,
  })
  return {
    relay,
    walletServicePubkey: connection.walletServicePubkey,
    state,
    stop: service.stop,
  }
}

beforeEach(async () => {
  stubLocalStorage()
  await saveLinkingKey(LINKING_KEY)
  resetNow()
})
