// Nostr backup: key derivation stability, event build/parse round-trips,
// tamper rejection, publish/fetch and restore against an in-memory relay
// (the transport is injected - no network), and the debounced publisher.

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {bytesToHex} from '@noble/hashes/utils.js'
import type {NostrEvent} from 'nostr-tools/core'
import {finalizeEvent, getPublicKey} from 'nostr-tools/pure'
import {v2 as nip44v2} from 'nostr-tools/nip44'
import {buildNoteUrl} from 'lnurlcash-kit'

import {deriveBearerAesKey} from './keys'
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
  restoreFromNostr
} from './nostrBackup'
import type {BackupPartPayload, BackupTransport} from './nostrBackup'
import {
  loadBearers,
  loadSettings,
  mergeBearers,
  persistBearer,
  persistSettings,
  readEncryptedBearers
} from './storage'
import type {Bearer} from './types'
import {
  addTrustedMint,
  clearTrustedMints,
  isMintUnconfirmed,
  readTrustedMints
} from './trustedMints'
import {stubLocalStorage} from './test-utils'

const LINKING_KEY = new Uint8Array(32).fill(7)
const OTHER_KEY = new Uint8Array(32).fill(9)

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
  ...overrides
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
          e =>
            (!filter.kinds || filter.kinds.includes(e.kind)) &&
            (!filter.authors || filter.authors.includes(e.pubkey))
        )
      )
  }
  return {transport, events}
}

// flips the end of a base64 payload to different-but-valid characters
const tamperContent = (content: string): string =>
  content.slice(0, -4) + (content.endsWith('AAAA') ? 'BBBB' : 'AAAA')

beforeEach(() => {
  stubLocalStorage()
  // the trusted-mint registry caches module-level - reset it alongside
  // the storage stub
  clearTrustedMints()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('deriveBackupKey', () => {
  it('derives a stable key from the linking key', () => {
    // pinned: changing the context string or the construction would
    // silently orphan every backup ever published - the wallet would
    // derive a different pubkey and find nothing to restore
    expect(bytesToHex(deriveBackupKey(LINKING_KEY))).toBe(
      'a583f5740869d240d3052442957a46ec5f2534f8ae0284f7f7f8b03d602edad9'
    )
  })

  it('derives a different key from a different linking key', () => {
    expect(bytesToHex(deriveBackupKey(OTHER_KEY))).not.toBe(
      bytesToHex(deriveBackupKey(LINKING_KEY))
    )
  })
})

describe('buildBackupEvent / parseBackupEvent', () => {
  const secretKey = deriveBackupKey(LINKING_KEY)

  const records = [
    // long unique sentinel id: a short id like 'r1' randomly appears in
    // base64 ciphertext (~17% for 700 chars), which flakes the no-plaintext
    // assertion below
    {id: 'record-id-plaintext-sentinel-7f3a', iv: '00'.repeat(12), ciphertext: 'ab'.repeat(40)}
  ]
  const mints = [
    {server: 'mint.example', mintPubkey: MINT_PUBKEY, addedAt: 1000, locked: true}
  ]
  const settings = {defaultMint: 'mint.example'}

  it('round-trips all three parts through build and parse', () => {
    const events = buildBackupEvents(secretKey, {notes: records, mints, settings}, 1000)
    expect(events).toHaveLength(3)
    expect(events.map(e => e.kind)).toEqual([
      BACKUP_EVENT_KIND,
      BACKUP_EVENT_KIND,
      BACKUP_EVENT_KIND
    ])
    expect(events.map(e => e.tags)).toEqual([
      [['d', 'notes']],
      [['d', 'mints']],
      [['d', 'settings']]
    ])
    expect(events.every(e => e.pubkey === backupPubkey(secretKey))).toBe(true)

    expect(parseBackupEvent(secretKey, events[0]!)).toEqual({
      part: 'notes',
      bearers: records
    })
    expect(parseBackupEvent(secretKey, events[1]!)).toEqual({
      part: 'mints',
      trustedMints: mints
    })
    expect(parseBackupEvent(secretKey, events[2]!)).toEqual({
      part: 'settings',
      settings
    })
  })

  it('leaves no plaintext in the payload', () => {
    const event = buildBackupEvent(secretKey, 'notes', records)
    expect(event.content).not.toContain('record-id-plaintext-sentinel-7f3a')
    expect(event.content).not.toContain('ciphertext')
  })

  it('builds events only for the parts present', () => {
    const events = buildBackupEvents(secretKey, {settings}, 1000)
    expect(events).toHaveLength(1)
    expect(events[0]!.tags).toEqual([['d', 'settings']])
  })

  it('rejects a payload encrypted for a different key', () => {
    const event = buildBackupEvent(secretKey, 'settings', settings)
    expect(parseBackupEvent(deriveBackupKey(OTHER_KEY), event)).toBeNull()
  })

  it('rejects the wrong kind', () => {
    const event = buildBackupEvent(secretKey, 'settings', settings)
    expect(parseBackupEvent(secretKey, {...event, kind: 30079})).toBeNull()
  })

  it('rejects an unknown d-tag', () => {
    const event = buildBackupEvent(secretKey, 'settings', settings)
    expect(parseBackupEvent(secretKey, {...event, tags: [['d', 'secrets']]})).toBeNull()
  })

  it('rejects a modified ciphertext - the signature no longer matches', () => {
    const event = buildBackupEvent(secretKey, 'settings', settings)
    const tampered = {...event, content: tamperContent(event.content)}
    expect(parseBackupEvent(secretKey, tampered)).toBeNull()
  })

  it('rejects an event signed by a different key', () => {
    const foreign = buildBackupEvent(deriveBackupKey(OTHER_KEY), 'settings', settings)
    expect(parseBackupEvent(secretKey, foreign)).toBeNull()
  })

  it('rejects a validly signed event whose payload is not a backup envelope', () => {
    // a same-key event of the right kind and d-tag, but its decrypted
    // content is not a version-1 envelope
    const conversationKey = nip44v2.utils.getConversationKey(
      secretKey,
      getPublicKey(secretKey)
    )
    const event = finalizeEvent(
      {
        kind: BACKUP_EVENT_KIND,
        created_at: 1000,
        tags: [['d', 'settings']],
        content: nip44v2.encrypt(
          JSON.stringify({version: 2, settings: {}}),
          conversationKey
        )
      },
      secretKey
    )
    expect(parseBackupEvent(secretKey, event)).toBeNull()
  })
})

describe('publishBackup / fetchBackup', () => {
  const secretKey = deriveBackupKey(LINKING_KEY)

  it('publishes every part and fetches them back decrypted', async () => {
    const {transport} = createRecordingTransport()
    const parts = {
      notes: [{id: 'r1', iv: '00'.repeat(12), ciphertext: 'ab'.repeat(40)}],
      mints: [
        {server: 'mint.example', mintPubkey: MINT_PUBKEY, addedAt: 1000, locked: false}
      ],
      settings: {defaultMint: 'mint.example'}
    }
    const published = await publishBackup(secretKey, parts, RELAYS, {transport})
    expect(published.published).toEqual(['notes', 'mints', 'settings'])

    const fetched = await fetchBackup(backupPubkey(secretKey), RELAYS, {
      secretKey,
      transport
    })
    expect(fetched).toEqual(parts)
  })

  it('publishes nothing when no parts are given', async () => {
    const {transport, events} = createRecordingTransport()
    const result = await publishBackup(secretKey, {}, RELAYS, {transport})
    expect(result.published).toEqual([])
    expect(events).toEqual([])
  })

  it('picks the newest event per d-tag when a relay serves stale copies', async () => {
    const {transport} = createRecordingTransport()
    await publishBackup(secretKey, {settings: {defaultMint: 'old.example'}}, RELAYS, {
      transport,
      createdAt: 1000
    })
    await publishBackup(secretKey, {settings: {defaultMint: 'new.example'}}, RELAYS, {
      transport,
      createdAt: 2000
    })
    // the recording transport serves BOTH - the newer must win
    const parts = await fetchBackup(backupPubkey(secretKey), RELAYS, {
      secretKey,
      transport
    })
    expect(parts.settings).toEqual({defaultMint: 'new.example'})
  })

  it('falls back to an older valid copy when the newest event is tampered', async () => {
    const {transport, events} = createRecordingTransport()
    await publishBackup(secretKey, {settings: {defaultMint: 'mint.example'}}, RELAYS, {
      transport,
      createdAt: 1000
    })
    events.push({
      ...events[0]!,
      content: tamperContent(events[0]!.content),
      created_at: 3000
    })
    const parts = await fetchBackup(backupPubkey(secretKey), RELAYS, {
      secretKey,
      transport
    })
    expect(parts.settings).toEqual({defaultMint: 'mint.example'})
  })
})

describe('restoreFromNostr', () => {
  it('restores notes, mints and settings onto a fresh device through applyBackup', async () => {
    const aesKey = await deriveBearerAesKey(LINKING_KEY)
    const secretKey = deriveBackupKey(LINKING_KEY)
    const {transport} = createRecordingTransport()

    // device A: one note, one trusted mint, one setting - all published
    await persistBearer(aesKey, bearerFixture({id: 'note-a'}))
    addTrustedMint('mint.example', MINT_PUBKEY)
    persistSettings({defaultMint: 'mint.example'})
    await publishBackup(
      secretKey,
      {
        notes: readEncryptedBearers(),
        mints: readTrustedMints(),
        settings: loadSettings()
      },
      RELAYS,
      {transport}
    )

    // device B: the same seed on empty storage
    stubLocalStorage()
    clearTrustedMints()
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
    expect(isMintUnconfirmed('mint.example')).toBe(true)
  })

  it('unions records by id and lets a spent copy win after decrypt', async () => {
    const aesKey = await deriveBearerAesKey(LINKING_KEY)
    const secretKey = deriveBackupKey(LINKING_KEY)
    const {transport} = createRecordingTransport()

    // device A publishes its store holding the spendable note
    await persistBearer(aesKey, bearerFixture({id: 'rec-a'}))
    await publishBackup(secretKey, {notes: readEncryptedBearers()}, RELAYS, {
      transport,
      createdAt: 1000
    })

    // device B restores, then marks the same note spent under its OWN
    // record id, and republishes its full store
    stubLocalStorage()
    clearTrustedMints()
    await restoreFromNostr(LINKING_KEY, RELAYS, {transport})
    await persistBearer(aesKey, bearerFixture({id: 'rec-b', spent: true, updatedAt: 2000}))
    await publishBackup(secretKey, {notes: readEncryptedBearers()}, RELAYS, {
      transport,
      createdAt: 2000
    })

    // device C restores from the final published state
    stubLocalStorage()
    clearTrustedMints()
    const result = await restoreFromNostr(LINKING_KEY, RELAYS, {transport})

    // union by record id: both copies landed
    expect(result.added).toBe(2)
    expect(readEncryptedBearers().map(r => r.id).sort()).toEqual(['rec-a', 'rec-b'])

    // after decrypt, the note-level merge (same server + k1) collapses
    // them, and the spent copy wins even though its record is the newer
    // arrival - a restored backup must never resurrect spendable money
    const merged = mergeBearers([], await loadBearers(aesKey))
    expect(merged).toHaveLength(1)
    expect(merged[0]!.id).toBe('rec-b')
    expect(merged[0]!.spent).toBe(true)
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
      {transport, createdAt: 1000}
    )

    // this device already has its own wallet state
    stubLocalStorage()
    clearTrustedMints()
    await persistBearer(
      aesKey,
      bearerFixture({id: 'local', url: buildNoteUrl('https://mint.example/w', K1_B, 5_000)})
    )
    persistSettings({defaultMint: 'local.example'})

    const result = await restoreFromNostr(LINKING_KEY, RELAYS, {transport})
    expect(result.added).toBe(1)
    expect(readEncryptedBearers().map(r => r.id).sort()).toEqual(['local', 'remote'])
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

describe('createBackupPublisher', () => {
  it('coalesces rapid schedules into a single publish of the latest snapshot', async () => {
    vi.useFakeTimers()
    const published: Partial<BackupPartPayload>[] = []
    const publisher = createBackupPublisher({
      publish: p => {
        published.push(p)
        return Promise.resolve()
      },
      delayMs: 1000
    })

    publisher.schedule({settings: {defaultMint: 'a'}})
    publisher.schedule({settings: {defaultMint: 'b'}})
    publisher.schedule({settings: {defaultMint: 'c'}})
    await vi.advanceTimersByTimeAsync(999)
    expect(published).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(published).toEqual([{settings: {defaultMint: 'c'}}])
  })

  it('publishes again when a change lands after the quiet window', async () => {
    vi.useFakeTimers()
    const published: Partial<BackupPartPayload>[] = []
    const publisher = createBackupPublisher({
      publish: p => {
        published.push(p)
        return Promise.resolve()
      },
      delayMs: 1000
    })

    publisher.schedule({settings: {defaultMint: 'a'}})
    await vi.advanceTimersByTimeAsync(1000)
    publisher.schedule({settings: {defaultMint: 'b'}})
    await vi.advanceTimersByTimeAsync(1000)
    expect(published).toEqual([
      {settings: {defaultMint: 'a'}},
      {settings: {defaultMint: 'b'}}
    ])
  })

  it('publishes a snapshot that lands mid-publish instead of losing it', async () => {
    vi.useFakeTimers()
    const published: Partial<BackupPartPayload>[] = []
    // the publish callback re-schedules on the publisher being created -
    // a holder indirection keeps both const
    const holder: {publisher?: ReturnType<typeof createBackupPublisher>} = {}
    const publisher = createBackupPublisher({
      publish: p => {
        published.push(p)
        // a local change lands while the first publish is in flight
        if (published.length === 1) {
          holder.publisher?.schedule({settings: {defaultMint: 'mid-flight'}})
        }
        return Promise.resolve()
      },
      delayMs: 1000
    })
    holder.publisher = publisher

    publisher.schedule({settings: {defaultMint: 'first'}})
    await vi.advanceTimersByTimeAsync(1000)
    expect(published).toEqual([
      {settings: {defaultMint: 'first'}},
      {settings: {defaultMint: 'mid-flight'}}
    ])
  })

  it('flush publishes immediately; cancel drops the pending snapshot', async () => {
    vi.useFakeTimers()
    const published: Partial<BackupPartPayload>[] = []
    const publisher = createBackupPublisher({
      publish: p => {
        published.push(p)
        return Promise.resolve()
      },
      delayMs: 60_000
    })

    publisher.schedule({settings: {defaultMint: 'a'}})
    await publisher.flush()
    expect(published).toEqual([{settings: {defaultMint: 'a'}}])

    publisher.schedule({settings: {defaultMint: 'b'}})
    publisher.cancel()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(published).toHaveLength(1)
  })

  it('reports a failed publish via onError and retries on the next change', async () => {
    vi.useFakeTimers()
    const published: Partial<BackupPartPayload>[] = []
    const errors: unknown[] = []
    let failing = true
    const publisher = createBackupPublisher({
      publish: p => {
        if (failing) return Promise.reject(new Error('relay down'))
        published.push(p)
        return Promise.resolve()
      },
      delayMs: 1000,
      onError: e => {
        errors.push(e)
      }
    })

    publisher.schedule({settings: {defaultMint: 'a'}})
    await vi.advanceTimersByTimeAsync(1000)
    expect(published).toEqual([])
    expect(errors).toHaveLength(1)

    failing = false
    publisher.schedule({settings: {defaultMint: 'b'}})
    await vi.advanceTimersByTimeAsync(1000)
    expect(published).toEqual([{settings: {defaultMint: 'b'}}])
  })
})
