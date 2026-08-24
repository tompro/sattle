// Nostr backup: key derivation stability, event build/parse round-trips,
// tamper rejection, publish/fetch and restore against an in-memory relay
// (the transport is injected - no network), and the debounced publisher.

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {bytesToHex} from '@noble/hashes/utils.js'
import type {NostrEvent} from 'nostr-tools/core'
import {finalizeEvent, getPublicKey} from 'nostr-tools/pure'
import {v2 as nip44v2} from 'nostr-tools/nip44'
import {buildNoteUrl} from 'lnurlcash-kit'

import {deriveBearerAesKey, linkingPubKeyHex, saveLinkingKey} from './keys'
import {
  BACKUP_EVENT_KIND,
  backupPubkey,
  buildBackupEvent,
  buildBackupEvents,
  createBackupPublisher,
  deriveBackupKey,
  fetchBackup,
  parseBackupEvent,
  publishBackup,
  restoreFromNostr,
} from './nostrBackup'
import type {BackupPartPayload, BackupTransport} from './nostrBackup'
import {
  loadBearers,
  loadSettings,
  mergeBearers,
  persistBearer,
  persistSettings,
  readEncryptedBearers,
} from './storage'
import type {Bearer} from './types'
import {addTrustedMint, isMintUnconfirmed, readTrustedMints} from './trustedMints'
import {requiredValue, stubLocalStorage} from './test-utils'

const LINKING_KEY = new Uint8Array(32).fill(7)
const OTHER_KEY = new Uint8Array(32).fill(9)
const OWNER_ID = linkingPubKeyHex(LINKING_KEY)

const K1_A = 'aa'.repeat(32)
const K1_B = 'bb'.repeat(32)
const MINT_PUBKEY = 'ab'.repeat(33)

// never connected - the recording transport below stands in for the relays
const RELAYS = ['wss://relay-a.example', 'wss://relay-b.example']

const bearerFixture = (overrides: Partial<Bearer> = {}): Bearer => ({
  id: 'fixture',
  url: buildNoteUrl('https://mint.example/w', K1_A, 21_000),
  callback: 'https://mint.example/w/cb',
  amount: 21_000,
  verified: true,
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
})

// an in-memory relay set. It serves EVERY event it ever accepted, older
// addressable copies included - like a relay that never replaces - which
// is exactly the case fetchBackup's client-side latest-pick exists for
const createRecordingTransport = (): {
  transport: BackupTransport
  events: NostrEvent[]
} => {
  const events: NostrEvent[] = []
  const transport: BackupTransport = {
    publish: (_relays, event) => {
      events.push(event)
      return Promise.resolve()
    },
    fetch: (_relays, filter) =>
      Promise.resolve(
        events.filter(
          (e) =>
            (!filter.kinds || filter.kinds.includes(e.kind)) &&
            (!filter.authors || filter.authors.includes(e.pubkey)),
        ),
      ),
  }
  return {transport, events}
}

// flips the end of a base64 payload to different-but-valid characters
const tamperContent = (content: string): string =>
  content.slice(0, -4) + (content.endsWith('AAAA') ? 'BBBB' : 'AAAA')

beforeEach(() => {
  stubLocalStorage()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('restoreFromNostr', () => {
  it('restores notes, mints and settings onto a fresh device through applyBackup', async () => {
    const aesKey = await deriveBearerAesKey(LINKING_KEY)
    const secretKey = deriveBackupKey(LINKING_KEY)
    const {transport} = createRecordingTransport()

    // device A: one note, one trusted mint, one setting - all published
    await saveLinkingKey(LINKING_KEY)
    await persistBearer(aesKey, bearerFixture({id: 'note-a'}))
    await addTrustedMint('mint.example', MINT_PUBKEY, {ownerId: OWNER_ID})
    persistSettings({defaultMint: 'mint.example'})
    await publishBackup(
      secretKey,
      {
        notes: readEncryptedBearers(),
        mints: readTrustedMints(OWNER_ID),
        settings: loadSettings(),
      },
      RELAYS,
      {transport},
    )

    // device B: the same seed on empty storage
    stubLocalStorage()
    await saveLinkingKey(LINKING_KEY)
    const result = await restoreFromNostr(LINKING_KEY, RELAYS, {transport})

    expect(result.found).toEqual(['notes', 'mints', 'settings'])
    expect(result.added).toBe(1)
    expect(result.trustedMintsAdded).toBe(1)
    expect(result.settingsRestored).toBe(true)
    // the linking key is never part of a nostr backup - the seed phrase
    // the holder entered is its recovery path
    expect(result.linkingKeyRestored).toBe(false)

    // the note decrypts under this device's bearer key - same seed
    expect(await loadBearers(aesKey)).toEqual([bearerFixture({id: 'note-a'})])
    expect(loadSettings()).toEqual({defaultMint: 'mint.example'})
    // a file/backup-sourced mint pin stays unconfirmed until a live
    // response corroborates it - nostr restore inherits that rule from
    // applyBackup unchanged
    expect(isMintUnconfirmed('mint.example', OWNER_ID)).toBe(true)
  })

  it('unions records by id and lets a spent copy win after decrypt', async () => {
    const aesKey = await deriveBearerAesKey(LINKING_KEY)
    const secretKey = deriveBackupKey(LINKING_KEY)
    const {transport} = createRecordingTransport()

    // device A publishes its store holding the spendable note
    await persistBearer(aesKey, bearerFixture({id: 'rec-a'}))
    await publishBackup(secretKey, {notes: readEncryptedBearers()}, RELAYS, {
      transport,
      createdAt: 1000,
    })

    // device B restores, then marks the same note spent under its OWN
    // record id, and republishes its full store
    stubLocalStorage()
    await restoreFromNostr(LINKING_KEY, RELAYS, {transport})
    await persistBearer(aesKey, bearerFixture({id: 'rec-b', spent: true, updatedAt: 2000}))
    await publishBackup(secretKey, {notes: readEncryptedBearers()}, RELAYS, {
      transport,
      createdAt: 2000,
    })

    // device C restores from the final published state
    stubLocalStorage()
    const result = await restoreFromNostr(LINKING_KEY, RELAYS, {transport})

    // union by record id: both copies landed
    expect(result.added).toBe(2)
    expect(
      readEncryptedBearers()
        .map((r) => r.id)
        .sort(),
    ).toEqual(['rec-a', 'rec-b'])

    // after decrypt, the note-level merge (same server + k1) collapses
    // them, and the spent copy wins even though its record is the newer
    // arrival - a restored backup must never resurrect spendable money
    const merged = mergeBearers([], await loadBearers(aesKey))
    expect(merged).toHaveLength(1)
    expect(requiredValue(merged[0]).id).toBe('rec-b')
    expect(requiredValue(merged[0]).spent).toBe(true)
  })

  it('never overwrites local state: records union, settings keep local values', async () => {
    const aesKey = await deriveBearerAesKey(LINKING_KEY)
    const secretKey = deriveBackupKey(LINKING_KEY)
    const {transport} = createRecordingTransport()

    await persistBearer(aesKey, bearerFixture({id: 'remote'}))
    persistSettings({defaultMint: 'remote.example'})
    await publishBackup(
      secretKey,
      {notes: readEncryptedBearers(), settings: loadSettings()},
      RELAYS,
      {transport, createdAt: 1000},
    )

    // this device already has its own wallet state
    stubLocalStorage()
    await persistBearer(
      aesKey,
      bearerFixture({id: 'local', url: buildNoteUrl('https://mint.example/w', K1_B, 5_000)}),
    )
    persistSettings({defaultMint: 'local.example'})

    const result = await restoreFromNostr(LINKING_KEY, RELAYS, {transport})
    expect(result.added).toBe(1)
    expect(
      readEncryptedBearers()
        .map((r) => r.id)
        .sort(),
    ).toEqual(['local', 'remote'])
    expect(result.settingsRestored).toBe(false)
    expect(loadSettings()).toEqual({defaultMint: 'local.example'})
  })

  it('reports nothing found when the relays hold no backup', async () => {
    const {transport} = createRecordingTransport()
    const result = await restoreFromNostr(LINKING_KEY, RELAYS, {transport})
    expect(result.found).toEqual([])
    expect(result.added).toBe(0)
  })
})
