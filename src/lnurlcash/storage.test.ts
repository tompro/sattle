// Storage round-trips and backup merge semantics. Runs in Node against an
// in-memory localStorage stub; WebCrypto (crypto.subtle) is native.

import {beforeEach, describe, expect, it} from 'vitest'
import {buildNoteUrl} from 'lnurlcash-kit'

import type {Bearer} from './types'
import {deriveBearerAesKey} from './keys'
import {
  applyBackup,
  buildBackup,
  clearAllBearers,
  deleteBearerRecord,
  loadActivity,
  loadBearers,
  mergeBearers,
  newBearerId,
  persistActivityEvent,
  persistBearer,
  readEncryptedBearers,
  MAX_ACTIVITY_ENTRIES
} from './storage'
import {saveLinkingKey} from './keys'
import {stubLocalStorage} from './test-utils'

const LINKING_KEY = new Uint8Array(32).fill(7)
const OTHER_KEY = new Uint8Array(32).fill(9)

const K1_A = 'aa'.repeat(32)
const K1_B = 'bb'.repeat(32)

const bearerFixture = (overrides: Partial<Bearer> = {}): Bearer => ({
  id: newBearerId(),
  url: buildNoteUrl('https://mint.example/w', K1_A, 21_000),
  callback: 'https://mint.example/w/cb',
  amount: 21_000,
  verified: true,
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides
})

beforeEach(() => {
  stubLocalStorage()
})

describe('encrypted bearer records', () => {
  it('round-trips a bearer through AES-GCM storage', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    const bearer = bearerFixture()
    await persistBearer(key, bearer)

    // at rest, nothing plaintext leaks: no k1, no amounts
    const raw = localStorage.getItem('sattle_bearers')!
    expect(raw).not.toContain(K1_A)
    expect(raw).not.toContain('21000')

    const loaded = await loadBearers(key)
    expect(loaded).toEqual([bearer])
  })

  it('skips records written under a different seed without destroying them', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    const other = await deriveBearerAesKey(OTHER_KEY)
    await persistBearer(key, bearerFixture({id: 'mine'}))
    await persistBearer(other, bearerFixture({id: 'foreign', url: buildNoteUrl('https://mint.example/w', K1_B, 5_000)}))

    const loaded = await loadBearers(key)
    expect(loaded.map(b => b.id)).toEqual(['mine'])
    // the foreign ciphertext is still there, untouched
    expect(readEncryptedBearers().map(r => r.id).sort()).toEqual(['foreign', 'mine'])
  })

  it('overwrites a record when the same id is persisted again', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    const bearer = bearerFixture()
    await persistBearer(key, bearer)
    await persistBearer(key, {...bearer, spent: true, updatedAt: 2000})

    const loaded = await loadBearers(key)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]!.spent).toBe(true)
  })

  it('deletes a record by id and clears all', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    const a = bearerFixture({id: 'a'})
    const b = bearerFixture({id: 'b', url: buildNoteUrl('https://mint.example/w', K1_B, 5_000)})
    await persistBearer(key, a)
    await persistBearer(key, b)

    await deleteBearerRecord('a')
    expect((await loadBearers(key)).map(x => x.id)).toEqual(['b'])

    clearAllBearers()
    expect(readEncryptedBearers()).toEqual([])
  })
})

describe('activity log', () => {
  it('round-trips events newest-first', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    await persistActivityEvent(key, {id: '1', kind: 'mint', message: 'a', createdAt: 1000})
    await persistActivityEvent(key, {id: '2', kind: 'melt', message: 'b', createdAt: 2000})

    const loaded = await loadActivity(key)
    expect(loaded.map(e => e.id)).toEqual(['2', '1'])
  })

  it('caps the log, rolling the oldest entries off', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    for (let i = 0; i < MAX_ACTIVITY_ENTRIES + 5; i++) {
      await persistActivityEvent(key, {
        id: `ev-${i}`,
        kind: 'receive',
        message: `event ${i}`,
        createdAt: i
      })
    }
    const loaded = await loadActivity(key)
    expect(loaded).toHaveLength(MAX_ACTIVITY_ENTRIES)
    // the five oldest rolled off; the newest is first
    expect(loaded[0]!.id).toBe(`ev-${MAX_ACTIVITY_ENTRIES + 4}`)
    expect(loaded.at(-1)!.id).toBe('ev-5')
  }, 30_000)
})

describe('mergeBearers (union by note id, spent-wins)', () => {
  it('unions notes with distinct secrets', () => {
    const a = bearerFixture({id: 'a'})
    const b = bearerFixture({id: 'b', url: buildNoteUrl('https://mint.example/w', K1_B, 5_000)})
    const merged = mergeBearers([a], [b])
    expect(merged.map(x => x.id).sort()).toEqual(['a', 'b'])
  })

  it('lets the spent copy of a note win over a still-spendable one', () => {
    const spendable = bearerFixture({id: 'old-copy', updatedAt: 3000})
    const spent = bearerFixture({id: 'new-copy', spent: true, updatedAt: 1000})
    // same note (same server + k1), different record ids, and the spent
    // copy is even the STALER one - spent still wins, or a restored backup
    // would resurrect burned money
    const merged = mergeBearers([spendable], [spent])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.id).toBe('new-copy')
    expect(merged[0]!.spent).toBe(true)
  })

  it('keeps the newer copy when both agree on spent state', () => {
    const stale = bearerFixture({id: 'stale', updatedAt: 1000, amount: 1})
    const fresh = bearerFixture({id: 'fresh', updatedAt: 2000, amount: 2})
    const merged = mergeBearers([stale], [fresh])
    expect(merged).toHaveLength(1)
    expect(merged[0]!.id).toBe('fresh')
  })

  it('treats the same secret on different servers as different notes', () => {
    const here = bearerFixture({id: 'here'})
    const there = bearerFixture({
      id: 'there',
      url: buildNoteUrl('https://other.example/w', K1_A, 21_000)
    })
    expect(mergeBearers([here], [there])).toHaveLength(2)
  })
})

describe('backup', () => {
  it('never exports a plaintext linking key', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    await saveLinkingKey(LINKING_KEY) // no password: stored plaintext
    await persistBearer(key, bearerFixture())

    const backup = buildBackup()
    expect(backup.type).toBe('sattle-backup')
    expect(backup.linkingKey).toBeUndefined()
    expect(backup.bearers).toHaveLength(1)
  })

  it('exports the linking key when it is itself password-encrypted', async () => {
    await saveLinkingKey(LINKING_KEY, 'hunter2')
    const backup = buildBackup()
    expect(backup.linkingKey?.enc).toBe(true)
  })

  it('merges a backup by record id - union, never overwrite', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    await persistBearer(key, bearerFixture({id: 'existing'}))

    // a backup holding the same record id plus a new one
    const backup = buildBackup()
    const incoming = {
      ...backup,
      bearers: [
        ...backup.bearers,
        {id: 'from-backup', iv: '00'.repeat(12), ciphertext: 'ab'.repeat(40)}
      ]
    }
    const result = applyBackup(incoming)
    expect(result.added).toBe(1)
    expect(result.skipped).toBe(1)
    expect(readEncryptedBearers().map(r => r.id).sort()).toEqual([
      'existing',
      'from-backup'
    ])
  })

  it('restores the linking key only onto a device that has none', async () => {
    await saveLinkingKey(LINKING_KEY, 'hunter2')
    const backup = buildBackup()

    // same device: a key already exists, so the backup's key is skipped
    const here = applyBackup(backup)
    expect(here.linkingKeySkipped).toBe(true)
    expect(here.linkingKeyRestored).toBe(false)

    // fresh device: the key installs
    stubLocalStorage()
    const fresh = applyBackup(backup)
    expect(fresh.linkingKeyRestored).toBe(true)
    expect(fresh.linkingKeySkipped).toBe(false)
  })

  it('rejects a file that is not a sattle backup', () => {
    expect(() => applyBackup({type: 'lnurlwallet-backup', version: 1, bearers: []})).toThrow()
    expect(() => applyBackup(null)).toThrow()
    expect(() => applyBackup({type: 'sattle-backup', version: 2, bearers: []})).toThrow()
  })

  it('skips malformed records instead of failing the whole restore', () => {
    const result = applyBackup({
      type: 'sattle-backup',
      version: 1,
      createdAt: 1,
      bearers: [
        {id: 'ok', iv: '00'.repeat(12), ciphertext: 'ab'.repeat(40)},
        {id: 42, iv: null, ciphertext: 'xx'},
        'garbage'
      ]
    })
    expect(result.added).toBe(1)
    expect(result.skipped).toBe(2)
  })
})
