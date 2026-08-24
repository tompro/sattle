// Imported by storage.test.ts so the focused storage command exercises the
// fund-critical changeset boundary without mixing it into unrelated storage
// round-trip and backup cases.

import {describe, expect, it, vi} from 'vitest'
import {buildNoteUrl} from 'lnurlcash-kit'

import {deriveBearerAesKey, encryptRecord} from './keys'
import {
  applyBearerChangeset,
  deleteBearerRecord,
  loadBearers,
  newBearerId,
  persistBearer,
  readEncryptedBearers,
} from './storage'
import type {BearerChangeset} from './storage'
import type {Bearer, NewBearer} from './types'

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

describe('baseline: per-record bearer persistence', () => {
  it('writes once for every persist or delete call', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    const writes = vi.spyOn(localStorage, 'setItem')

    await persistBearer(key, bearerFixture({id: 'a'}))
    await persistBearer(key, bearerFixture({id: 'b'}))
    await deleteBearerRecord('a')

    expect(
      writes.mock.calls.filter(([storageKey]) => storageKey === 'sattle_bearers'),
    ).toHaveLength(3)
  })
})

describe('applyBearerChangeset', () => {
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
    const snapshot = [oldA, oldB]
    const changeset: BearerChangeset = {
      add: [
        newBearerFixture(),
        newBearerFixture({
          url: buildNoteUrl('https://mint.example/w', K1_D, 4_000),
          amount: 4_000,
        }),
      ],
      markSpent: ['old-a', 'old-b'],
    }
    const writes = vi.spyOn(localStorage, 'setItem')

    const result = await applyBearerChangeset(key, snapshot, changeset)

    expect(
      writes.mock.calls.filter(([storageKey]) => storageKey === 'sattle_bearers'),
    ).toHaveLength(1)
    expect(result).toHaveLength(4)
    expect(result.slice(2).map((bearer) => bearer.spent)).toEqual([true, true])
    expect(result[0]?.id).not.toBe(result[1]?.id)
    expect(snapshot.map((bearer) => bearer.spent)).toEqual([undefined, undefined])
    expect(changeset.markSpent).toEqual(['old-a', 'old-b'])
    expect(changeset.add.some((note) => 'id' in note)).toBe(false)
    expect((await loadBearers(key)).map((bearer) => bearer.id).sort()).toEqual(
      result.map((bearer) => bearer.id).sort(),
    )
    const raw = localStorage.getItem('sattle_bearers') ?? ''
    expect(raw).not.toContain(K1_C)
    expect(raw).not.toContain(K1_D)
  })

  it('writes nothing when the second record encryption fails', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    await persistBearer(key, bearerFixture({id: 'kept'}))
    const writes = vi.spyOn(localStorage, 'setItem')
    const encrypt = vi.spyOn(crypto.subtle, 'encrypt')
    encrypt
      .mockResolvedValueOnce(new ArrayBuffer(32))
      .mockRejectedValueOnce(new Error('second encryption failed'))

    try {
      await expect(
        applyBearerChangeset(key, [], {
          add: [
            newBearerFixture(),
            newBearerFixture({
              url: buildNoteUrl('https://mint.example/w', K1_D, 4_000),
            }),
          ],
          markSpent: [],
        }),
      ).rejects.toThrow('second encryption failed')
      expect(encrypt).toHaveBeenCalledTimes(2)
      expect(
        writes.mock.calls.filter(([storageKey]) => storageKey === 'sattle_bearers'),
      ).toHaveLength(0)
      expect(readEncryptedBearers().map((record) => record.id)).toEqual(['kept'])
    } finally {
      encrypt.mockRestore()
    }
  })

  it('rejects a failed storage write without changing persisted state', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    const kept = bearerFixture({id: 'kept'})
    await persistBearer(key, kept)
    const before = localStorage.getItem('sattle_bearers')
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    vi.stubGlobal('navigator', {})

    try {
      await expect(
        applyBearerChangeset(key, [kept], {
          add: [newBearerFixture()],
          markSpent: ['kept'],
        }),
      ).rejects.toThrow('QuotaExceededError')
      expect(localStorage.getItem('sattle_bearers')).toBe(before)
    } finally {
      write.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('deduplicates repeated spent ids into one stored replacement', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    const bearer = bearerFixture({id: 'duplicate'})
    await persistBearer(key, bearer)

    const result = await applyBearerChangeset(key, [bearer], {
      add: [],
      markSpent: ['duplicate', 'duplicate'],
    })

    expect(readEncryptedBearers().filter((record) => record.id === 'duplicate')).toHaveLength(1)
    expect(result[0]?.spent).toBe(true)
    expect((await loadBearers(key))[0]?.spent).toBe(true)
  })

  it('encrypts before locking and preserves a fresh unrelated record', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    const other = await deriveBearerAesKey(OTHER_KEY)
    const mine = bearerFixture({id: 'mine'})
    const foreign = bearerFixture({
      id: 'fresh-tab',
      url: buildNoteUrl('https://mint.example/w', K1_B, 9_000),
    })
    await persistBearer(key, mine)
    const {id: foreignId, ...foreignPlain} = foreign
    const foreignParts = await encryptRecord(other, foreignPlain)
    const encrypted = vi.spyOn(crypto.subtle, 'encrypt')
    const queue: {release: () => Promise<void>}[] = []
    vi.stubGlobal('navigator', {
      locks: {
        request: (_name: string, fn: () => unknown): Promise<unknown> =>
          new Promise((resolve, reject) => {
            queue.push({
              release: async () => {
                await Promise.resolve(fn)
                  .then((callback) => callback())
                  .then(resolve, reject)
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
      await vi.waitFor(() => expect(queue).toHaveLength(1))
      expect(encrypted).toHaveBeenCalledTimes(1)
      localStorage.setItem(
        'sattle_bearers',
        JSON.stringify([...readEncryptedBearers(), {id: foreignId, ...foreignParts}]),
      )
      const pendingLock = queue.at(0)
      if (pendingLock === undefined) throw new Error('Expected pending lock')

      await pendingLock.release()
      const result = await commit

      expect(
        readEncryptedBearers()
          .map((record) => record.id)
          .sort(),
      ).toEqual(['fresh-tab', 'mine', result[0]?.id].sort())
      expect((await loadBearers(other)).map((bearer) => bearer.id)).toEqual(['fresh-tab'])
    } finally {
      encrypted.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('replaces corrupt JSON with the single committed changeset write', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY)
    localStorage.setItem('sattle_bearers', 'not json {{{')
    const writes = vi.spyOn(localStorage, 'setItem')

    const result = await applyBearerChangeset(key, [], {
      add: [newBearerFixture()],
      markSpent: ['missing'],
    })

    expect(result).toHaveLength(1)
    expect(
      writes.mock.calls.filter(([storageKey]) => storageKey === 'sattle_bearers'),
    ).toHaveLength(1)
    expect((await loadBearers(key)).map((bearer) => bearer.id)).toEqual(
      result.map((bearer) => bearer.id),
    )
  })
})
