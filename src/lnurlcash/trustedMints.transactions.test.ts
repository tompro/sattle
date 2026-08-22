// Owner-bound trusted-mint transactions under deterministic Web Locks.
// The fake parks every request until the test releases it in FIFO order.

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {linkingPubKeyHex, saveLinkingKey} from './keys'
import {
  addTrustedMint,
  cacheTrustedMintNodeInfo,
  clearTrustedMints,
  confirmTrustedMintRekey,
  lockTrustedMint,
  mergeTrustedMints,
  onTrustedMintsChange,
  readTrustedMints,
  removeTrustedMint,
  type TrustedMint,
} from './trustedMints'
import {stubLocalStorage} from './test-utils'

const STORAGE_KEY = 'sattle_trusted_mints'
const LINKING_KEY_A = new Uint8Array(32).fill(7)
const OWNER_A = linkingPubKeyHex(LINKING_KEY_A)
const OWNER_B = linkingPubKeyHex(new Uint8Array(32).fill(9))
const KEY_A = '02' + 'aa'.repeat(32)
const KEY_B = '03' + 'bb'.repeat(32)
const KEY_C = '02' + 'cc'.repeat(32)
const SERVER = 'mint.example'

type LockRequest = {
  readonly name: string
  readonly callback: () => unknown
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
}

class DeferredLocks {
  readonly requests: LockRequest[] = []
  held = false

  readonly request = (name: string, callback: () => unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      this.requests.push({name, callback, resolve, reject})
    })

  async releaseNext(): Promise<void> {
    const request = this.requests.shift()
    if (!request) throw new Error('Expected a queued lock request.')
    this.held = true
    try {
      request.resolve(await request.callback())
    } catch (error) {
      request.reject(error instanceof Error ? error : new Error(String(error)))
    } finally {
      this.held = false
    }
  }
}

const mint = (overrides: Partial<TrustedMint> = {}): TrustedMint => ({
  server: SERVER,
  mintPubkey: KEY_A,
  addedAt: 123,
  locked: false,
  ...overrides,
})

const store = (ownerId: string, mints: TrustedMint[]): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({version: 1, ownerId, mints}))
}

const installLocks = (): DeferredLocks => {
  const locks = new DeferredLocks()
  vi.stubGlobal('navigator', {locks})
  return locks
}

const waitForRequests = async (locks: DeferredLocks, count: number): Promise<void> => {
  await vi.waitFor(() => expect(locks.requests).toHaveLength(count))
}

beforeEach(async () => {
  vi.unstubAllGlobals()
  stubLocalStorage()
  await saveLinkingKey(LINKING_KEY_A)
})

describe('serialized owner-bound mutations', () => {
  it('reads current storage instead of retaining a stale snapshot', () => {
    store(OWNER_A, [mint({nodeAlias: 'first'})])
    expect(readTrustedMints(OWNER_A)[0]?.nodeAlias).toBe('first')

    store(OWNER_A, [mint({nodeAlias: 'external update'})])

    expect(readTrustedMints(OWNER_A)[0]?.nodeAlias).toBe('external update')
  })

  it('preserves two queued additions by reading fresh state in FIFO order', async () => {
    const locks = installLocks()
    const writes = vi.spyOn(localStorage, 'setItem')

    const first = addTrustedMint('one.example', KEY_A, {ownerId: OWNER_A})
    const second = addTrustedMint('two.example', KEY_B, {ownerId: OWNER_A})
    await waitForRequests(locks, 2)

    await locks.releaseNext()
    await locks.releaseNext()

    await expect(first).resolves.toBe('added')
    await expect(second).resolves.toBe('added')
    expect(readTrustedMints(OWNER_A).map((entry) => entry.server)).toEqual([
      'one.example',
      'two.example',
    ])
    expect(writes).toHaveBeenCalledTimes(2)
  })

  it('does not let metadata overwrite a concurrently staged rekey', async () => {
    store(OWNER_A, [mint()])
    const locks = installLocks()

    const rekey = lockTrustedMint(SERVER, KEY_B, OWNER_A)
    const metadata = cacheTrustedMintNodeInfo(SERVER, {nodeAlias: 'Fresh alias'}, OWNER_A)
    await waitForRequests(locks, 2)

    await locks.releaseNext()
    await locks.releaseNext()
    await Promise.all([rekey, metadata])

    expect(readTrustedMints(OWNER_A)[0]).toMatchObject({
      mintPubkey: KEY_A,
      pendingMintPubkey: KEY_B,
      nodeAlias: 'Fresh alias',
    })
  })

  it('keeps a new staged key after queued explicit confirmation', async () => {
    store(OWNER_A, [mint({pendingMintPubkey: KEY_B})])
    const locks = installLocks()

    const confirm = confirmTrustedMintRekey(SERVER, OWNER_A)
    const stage = lockTrustedMint(SERVER, KEY_C, OWNER_A)
    await waitForRequests(locks, 2)

    await locks.releaseNext()
    await locks.releaseNext()
    await Promise.all([confirm, stage])

    expect(readTrustedMints(OWNER_A)[0]).toMatchObject({
      mintPubkey: KEY_B,
      pendingMintPubkey: KEY_C,
    })
  })

  it('lets a live lock corroborate a queued backup merge', async () => {
    const locks = installLocks()
    const incoming = mint({locked: true, pendingMintPubkey: KEY_B})

    const merge = mergeTrustedMints([incoming], OWNER_A)
    const live = lockTrustedMint(SERVER, KEY_A, OWNER_A)
    await waitForRequests(locks, 2)

    await locks.releaseNext()
    await locks.releaseNext()
    await Promise.all([merge, live])

    expect(readTrustedMints(OWNER_A)[0]).toMatchObject({
      mintPubkey: KEY_A,
      locked: true,
    })
    expect(readTrustedMints(OWNER_A)[0]?.unconfirmed).toBeUndefined()
  })

  it('rejects queued removal after a live operation locks the mint', async () => {
    store(OWNER_A, [mint()])
    const locks = installLocks()

    const live = lockTrustedMint(SERVER, KEY_A, OWNER_A)
    const removal = removeTrustedMint(SERVER, OWNER_A)
    await waitForRequests(locks, 2)

    await locks.releaseNext()
    await locks.releaseNext()

    await expect(live).resolves.toBe('unchanged')
    await expect(removal).rejects.toThrow(/bearer/)
    expect(readTrustedMints(OWNER_A)[0]?.locked).toBe(true)
  })

  it('applies a queued clear after an earlier writer', async () => {
    store(OWNER_A, [mint()])
    const locks = installLocks()

    const add = addTrustedMint('queued.example', KEY_B, {ownerId: OWNER_A})
    const clear = clearTrustedMints(OWNER_A)
    await waitForRequests(locks, 2)

    await locks.releaseNext()
    await locks.releaseNext()
    await Promise.all([add, clear])

    expect(readTrustedMints(OWNER_A)).toEqual([])
  })

  it('rejects stale, malformed, and foreign-owner mutations', async () => {
    store(OWNER_B, [mint()])

    await expect(addTrustedMint('stale.example', KEY_B, {ownerId: OWNER_A})).rejects.toThrow(
      /owner/i,
    )
    await expect(addTrustedMint('invalid.example', KEY_B, {ownerId: 'invalid'})).rejects.toThrow(
      /owner/i,
    )

    expect(readTrustedMints(OWNER_B)).toEqual([mint()])
  })

  it('rejects a malformed stored envelope without overwriting it', async () => {
    const malformed = JSON.stringify({
      version: 1,
      ownerId: 'invalid',
      mints: [],
    })
    localStorage.setItem(STORAGE_KEY, malformed)

    await expect(addTrustedMint('new.example', KEY_B, {ownerId: OWNER_A})).rejects.toThrow(
      /malformed/i,
    )

    expect(localStorage.getItem(STORAGE_KEY)).toBe(malformed)
  })

  it('rejects a malformed mint member without rewriting stored bytes', async () => {
    const malformed = JSON.stringify({
      version: 1,
      ownerId: OWNER_A,
      mints: [mint(), mint({server: 'broken.example', mintPubkey: 'not-hex'})],
    })
    localStorage.setItem(STORAGE_KEY, malformed)

    await expect(addTrustedMint('new.example', KEY_B, {ownerId: OWNER_A})).rejects.toThrow(
      /malformed/i,
    )

    expect(localStorage.getItem(STORAGE_KEY)).toBe(malformed)
  })

  it('keeps storage and listeners unchanged when the single write fails', async () => {
    store(OWNER_A, [mint()])
    vi.stubGlobal('navigator', {})
    const before = localStorage.getItem(STORAGE_KEY)
    const notified = vi.fn()
    const unsubscribe = onTrustedMintsChange(notified)
    const setItem = localStorage.setItem.bind(localStorage)
    localStorage.setItem = (): void => {
      throw new Error('QuotaExceededError')
    }

    try {
      await expect(addTrustedMint('new.example', KEY_B, {ownerId: OWNER_A})).rejects.toThrow(
        'QuotaExceededError',
      )
      expect(localStorage.getItem(STORAGE_KEY)).toBe(before)
      expect(notified).not.toHaveBeenCalled()
    } finally {
      localStorage.setItem = setItem
      unsubscribe()
    }
  })

  it('notifies listeners only after the storage lock is released', async () => {
    const locks = installLocks()
    const lockStates: boolean[] = []
    const unsubscribe = onTrustedMintsChange(() => lockStates.push(locks.held))

    try {
      const addition = addTrustedMint(SERVER, KEY_A, {ownerId: OWNER_A})
      await waitForRequests(locks, 1)
      await locks.releaseNext()
      await addition

      expect(lockStates).toEqual([false])
    } finally {
      unsubscribe()
    }
  })
})
