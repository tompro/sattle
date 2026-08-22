// Bearer changeset persistence: applyBearerChangeset (the single-write
// commit primitive) plus a baseline pin of the per-record write behavior it
// replaces at the call sites. Lives next to bearers.ts instead of inside
// ../storage.test.ts to keep both files under the project's module size
// ceiling. Runs in Node against an in-memory localStorage stub; WebCrypto
// (crypto.subtle) is native.

import {beforeEach, describe, expect, it, vi} from 'vitest'
import {buildNoteUrl} from 'lnurlcash-kit'

import type {Bearer, NewBearer} from '../types'
import {deriveBearerAesKey, encryptRecord} from '../keys'
import {
  applyBearerChangeset,
  loadBearers,
  newBearerId,
  persistBearer,
  readEncryptedBearers,
} from '../storage'
import type {BearerChangeset} from '../storage'
import {writeEncryptedBearers} from './bearers'
import {requiredValue, stubLocalStorage} from '../test-utils'
import type {LocalStorageStub} from '../test-utils'
import './bearers.baseline.cases'

const LINKING_KEY = new Uint8Array(32).fill(7)
const OTHER_KEY = new Uint8Array(32).fill(9)

const K1_A = 'aa'.repeat(32)
const K1_B = 'bb'.repeat(32)
const K1_C = 'cc'.repeat(32)
const K1_D = 'dd'.repeat(32)

const bearerFixture = (overrides: Partial<Bearer> = {}): Bearer => ({
  id: newBearerId(),
  url: buildNoteUrl('https://mint.example/w', K1_A, 21_000),
  callback: 'https://mint.example/w/cb',
  amount: 21_000,
  verified: true,
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
})

const newBearerFixture = (overrides: Partial<NewBearer> = {}): NewBearer => ({
  url: buildNoteUrl('https://mint.example/w', K1_C, 3_000),
  callback: 'https://mint.example/w/cb',
  amount: 3_000,
  verified: true,
  ...overrides,
})

let stub: LocalStorageStub

beforeEach(() => {
  stub = stubLocalStorage()
})

const bearerWrites = (spy: {mock: {calls: unknown[][]}}): unknown[][] =>
  spy.mock.calls.filter(([k]) => k === 'sattle_bearers')

describe('applyBearerChangeset (single-write changeset commit)', () => {
  it('commits additions and spent replacements with exactly one write', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    const oldA = bearerFixture({id: 'old-a'})
    const oldB = bearerFixture({
      id: 'old-b',
      url: buildNoteUrl('https://mint.example/w', K1_B, 5_000),
      amount: 5_000,
    })
    await persistBearer(key, oldA)
    await persistBearer(key, oldB)

    const writes = vi.spyOn(stub, 'setItem')
    const result = await applyBearerChangeset(key, [oldA, oldB], {
      add: [
        newBearerFixture(),
        newBearerFixture({
          url: buildNoteUrl('https://mint.example/w', K1_D, 4_000),
          amount: 4_000,
        }),
      ],
      markSpent: ['old-a', 'old-b'],
    })

    // the whole changeset is ONE setItem on sattle_bearers
    expect(bearerWrites(writes)).toHaveLength(1)

    // the returned next list: additions first, then the snapshot with spent
    // marks applied
    expect(result).toHaveLength(4)
    const addA = requiredValue(result[0])
    const addB = requiredValue(result[1])
    const spentA = requiredValue(result[2])
    const spentB = requiredValue(result[3])
    expect(addA.id).not.toBe(addB.id)
    expect(addA.amount).toBe(3_000)
    expect(addB.amount).toBe(4_000)
    expect(addA.createdAt).toBe(addA.updatedAt)
    expect(spentA.id).toBe('old-a')
    expect(spentA.spent).toBe(true)
    expect(spentA.updatedAt).toBeGreaterThan(1000)
    expect(spentB.id).toBe('old-b')
    expect(spentB.spent).toBe(true)

    // the source of truth is the reloaded ciphertext, not the return value
    const reloaded = await loadBearers(key)
    expect(reloaded.map((b) => b.id).sort()).toEqual(result.map((b) => b.id).sort())
    expect(requiredValue(reloaded.find((b) => b.id === 'old-a')).spent).toBe(true)
    expect(requiredValue(reloaded.find((b) => b.id === 'old-b')).spent).toBe(true)
    expect(requiredValue(reloaded.find((b) => b.id === addA.id)).spent).toBeUndefined()
    // nothing plaintext leaked: the fresh k1s are ciphertext-only at rest
    const raw = requiredValue(localStorage.getItem('sattle_bearers'))
    expect(raw).not.toContain(K1_C)
    expect(raw).not.toContain(K1_D)
  })

  it('never mutates the caller snapshot or the changeset', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    const snapshot = [bearerFixture({id: 's1'})]
    const changeset: BearerChangeset = {
      add: [newBearerFixture()],
      markSpent: ['s1'],
    }

    await applyBearerChangeset(key, snapshot, changeset)

    expect(requiredValue(snapshot[0]).spent).toBeUndefined()
    expect('id' in requiredValue(changeset.add[0])).toBe(false)
    expect(changeset.markSpent).toEqual(['s1'])
  })

  it('persists nothing when encryption fails', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    await persistBearer(key, bearerFixture({id: 'kept'}))
    // a decrypt-only key makes every AES-GCM encrypt call reject
    const decryptOnly = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(32).fill(3),
      'AES-GCM',
      false,
      ['decrypt'],
    )
    const writes = vi.spyOn(stub, 'setItem')

    await expect(
      applyBearerChangeset(decryptOnly, [], {
        add: [newBearerFixture()],
        markSpent: [],
      }),
    ).rejects.toThrow()

    expect(bearerWrites(writes)).toHaveLength(0)
    expect(readEncryptedBearers().map((r) => r.id)).toEqual(['kept'])
  })

  it('rejects without a partial write when the storage write itself fails', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    const kept = bearerFixture({id: 'kept'})
    await persistBearer(key, kept)
    const before = readEncryptedBearers()
    stub.setItem = (): void => {
      throw new Error('QuotaExceededError')
    }
    // run this one through the unlocked fallback on purpose: a quota throw
    // is SYNCHRONOUS, and Node 24's real navigator.locks never releases a
    // lock whose callback throws synchronously (verified Node quirk - every
    // browser releases per the Web Locks spec), which would wedge
    // 'sattle_bearers' for the rest of the file. Bonus: one test keeps the
    // documented plain-Node fallback path (storageLock.ts) exercised.
    vi.stubGlobal('navigator', {})
    try {
      await expect(
        applyBearerChangeset(key, [kept], {
          add: [newBearerFixture()],
          markSpent: ['kept'],
        }),
      ).rejects.toThrow('QuotaExceededError')

      // nothing was persisted: the pre-existing record is byte-identical
      expect(readEncryptedBearers()).toEqual(before)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('upserts changed ids and dedupes repeated markSpent ids', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    const stale = bearerFixture({id: 'dup', updatedAt: 1000})
    await persistBearer(key, stale)

    const result = await applyBearerChangeset(key, [stale], {
      add: [],
      markSpent: ['dup', 'dup'],
    })

    // one record per id, never a duplicate append
    expect(readEncryptedBearers().filter((r) => r.id === 'dup')).toHaveLength(1)
    const reloaded = await loadBearers(key)
    expect(reloaded).toHaveLength(1)
    expect(requiredValue(reloaded[0]).spent).toBe(true)
    expect(requiredValue(result[0]).spent).toBe(true)
  })

  it('preserves a record another tab commits between the snapshot and the lock', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    const other = await deriveBearerAesKey(OTHER_KEY)
    const mine = bearerFixture({id: 'mine'})
    await persistBearer(key, mine)

    // a controllable Web Locks fake: lock requests park until the test
    // releases them, so a foreign write can interleave deterministically
    const queue: {name: string; release: () => Promise<void>}[] = []
    vi.stubGlobal('navigator', {
      locks: {
        request: (name: string, fn: () => unknown): Promise<unknown> =>
          new Promise((resolve, reject) => {
            queue.push({
              name,
              release: async () => {
                try {
                  resolve(await fn())
                } catch (error) {
                  reject(error instanceof Error ? error : new Error(String(error)))
                }
              },
            })
          }),
      },
    })
    try {
      const commit = applyBearerChangeset(key, [mine], {
        add: [newBearerFixture()],
        markSpent: [],
      })
      // encryption happens BEFORE the lock request; wait for it to arrive
      await vi.waitFor(() => {
        expect(queue).toHaveLength(1)
      })
      const queuedLock = requiredValue(queue[0])
      expect(queuedLock.name).toBe('sattle_bearers')

      // while our commit waits on the lock, another tab commits a record we
      // cannot even decrypt (written under a different seed's key)
      const foreign = bearerFixture({
        id: 'foreign-tab',
        url: buildNoteUrl('https://mint.example/w', K1_B, 9_000),
      })
      const {id: foreignId, ...foreignPlain} = foreign
      const foreignParts = await encryptRecord(other, foreignPlain)
      writeEncryptedBearers([...readEncryptedBearers(), {id: foreignId, ...foreignParts}])

      await queuedLock.release()
      const result = await commit

      // the foreign ciphertext survived our upsert, untouched
      expect(
        readEncryptedBearers()
          .map((r) => r.id)
          .sort(),
      ).toEqual(['foreign-tab', 'mine', requiredValue(result[0]).id].sort())
      expect((await loadBearers(other)).map((b) => b.id)).toEqual(['foreign-tab'])
      expect((await loadBearers(key)).map((b) => b.id).sort()).toEqual(
        ['mine', requiredValue(result[0]).id].sort(),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('treats corrupted stored JSON as an empty record set instead of throwing', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    localStorage.setItem('sattle_bearers', 'not json {{{')

    const result = await applyBearerChangeset(key, [], {
      add: [newBearerFixture()],
      markSpent: ['gone'],
    })

    // readEncryptedBearers' long-standing contract: unparseable storage
    // reads as [] (malformed entries are dropped, never thrown on) - the
    // changeset still commits and its single write replaces the corrupt blob
    expect(result).toHaveLength(1)
    expect((await loadBearers(key)).map((b) => b.id)).toEqual([requiredValue(result[0]).id])
  })

  it('ignores markSpent ids absent from the snapshot and writes nothing when nothing changed', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    const other = await deriveBearerAesKey(OTHER_KEY)
    await persistBearer(other, bearerFixture({id: 'foreign'}))
    const writes = vi.spyOn(stub, 'setItem')

    // 'foreign' is not in the caller's snapshot; deriving its spent copy
    // would require decrypting an unrelated record, which this primitive
    // never does - so the changeset changes nothing and performs no write
    const result = await applyBearerChangeset(key, [], {
      add: [],
      markSpent: ['foreign'],
    })

    expect(result).toEqual([])
    expect(bearerWrites(writes)).toHaveLength(0)
    expect(readEncryptedBearers().map((r) => r.id)).toEqual(['foreign'])
  })
})
