// A Web Lock handoff is not a localStorage visibility barrier. The next
// holder must reconcile from a durable cross-context commit before writing.

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {linkingPubKeyHex, saveLinkingKey} from './keys'
import {stubLocalStorage} from './test-utils'
import {addTrustedMint, readTrustedMints, type TrustedMint} from './trustedMints'
import {trustedMintsCommitStore} from './trustedMintsCommitStore'

const STORAGE_KEY = 'sattle_trusted_mints'
const LINKING_KEY = new Uint8Array(32).fill(7)
const OWNER_ID = linkingPubKeyHex(LINKING_KEY)
const OTHER_OWNER_ID = linkingPubKeyHex(new Uint8Array(32).fill(9))
const KEY_A = '02' + 'aa'.repeat(32)
const KEY_B = '03' + 'bb'.repeat(32)

const envelope = (mints: TrustedMint[]): string =>
  JSON.stringify({version: 1, ownerId: OWNER_ID, mints})

const mint = (server: string): TrustedMint => ({
  server,
  mintPubkey: KEY_A,
  addedAt: 1,
  locked: false,
})

beforeEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  stubLocalStorage()
  vi.stubGlobal('navigator', {
    locks: {
      request: (_name: string, callback: () => unknown): Promise<unknown> =>
        Promise.resolve().then(callback),
    },
  })
  await saveLinkingKey(LINKING_KEY)
})

describe('trusted-mint commit visibility', () => {
  it('reconciles the previous holder when localStorage is stale after lock handoff', async () => {
    // Given a durable commit mirror shared by two lock holders
    let committedRaw: string | null = null
    vi.spyOn(trustedMintsCommitStore, 'available').mockReturnValue(true)
    vi.spyOn(trustedMintsCommitStore, 'read').mockImplementation(async () => committedRaw)
    vi.spyOn(trustedMintsCommitStore, 'write').mockImplementation(async (raw) => {
      committedRaw = raw
    })

    localStorage.setItem(STORAGE_KEY, envelope([mint('remote.example')]))
    await addTrustedMint('first.example', KEY_A, {ownerId: OWNER_ID})

    // When the next holder sees the pre-commit localStorage view
    localStorage.setItem(STORAGE_KEY, envelope([mint('remote.example')]))
    const writes = vi.spyOn(localStorage, 'setItem')
    await addTrustedMint('second.example', KEY_B, {ownerId: OWNER_ID})

    // Then it writes one reconciled envelope and both accepted additions survive
    expect(readTrustedMints(OWNER_ID).map((entry) => entry.server)).toEqual([
      'remote.example',
      'first.example',
      'second.example',
    ])
    expect(writes).toHaveBeenCalledTimes(1)
  })

  it('does not resolve success before the durable commit mirror completes', async () => {
    // Given a commit store whose durable write is gated
    let releaseCommit: (() => void) | undefined
    vi.spyOn(trustedMintsCommitStore, 'available').mockReturnValue(true)
    vi.spyOn(trustedMintsCommitStore, 'read').mockResolvedValue(null)
    vi.spyOn(trustedMintsCommitStore, 'write').mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCommit = resolve
        }),
    )
    let settled = false

    // When a mutation has written localStorage but not the commit mirror
    const addition = addTrustedMint('first.example', KEY_A, {ownerId: OWNER_ID}).finally(() => {
      settled = true
    })
    await vi.waitFor(() => expect(releaseCommit).toBeTypeOf('function'))

    // Then success remains pending until the durable mirror completes
    expect(settled).toBe(false)
    releaseCommit?.()
    await expect(addition).resolves.toBe('added')
    expect(settled).toBe(true)
  })

  it('rejects malformed local bytes instead of trusting the commit mirror', async () => {
    // Given a valid mirror but malformed canonical local storage
    const malformed = '{'
    localStorage.setItem(STORAGE_KEY, malformed)
    vi.spyOn(trustedMintsCommitStore, 'available').mockReturnValue(true)
    const readMirror = vi
      .spyOn(trustedMintsCommitStore, 'read')
      .mockResolvedValue(envelope([mint('mirrored.example')]))

    // When a mutation attempts reconciliation, then malformed local bytes stay authoritative
    await expect(addTrustedMint('new.example', KEY_B, {ownerId: OWNER_ID})).rejects.toThrow(
      /malformed/i,
    )
    expect(localStorage.getItem(STORAGE_KEY)).toBe(malformed)
    expect(readMirror).not.toHaveBeenCalled()
  })

  it('rejects a foreign-owner commit mirror without rewriting local storage', async () => {
    // Given an owner-A local registry and an owner-B durable mirror
    const localRaw = envelope([mint('local.example')])
    const foreignRaw = JSON.stringify({
      version: 1,
      ownerId: OTHER_OWNER_ID,
      mints: [mint('foreign.example')],
    })
    localStorage.setItem(STORAGE_KEY, localRaw)
    vi.spyOn(trustedMintsCommitStore, 'available').mockReturnValue(true)
    vi.spyOn(trustedMintsCommitStore, 'read').mockResolvedValue(foreignRaw)

    // When owner A mutates, then exact owner validation rejects both sources unchanged
    await expect(addTrustedMint('new.example', KEY_B, {ownerId: OWNER_ID})).rejects.toThrow(
      /owner/i,
    )
    expect(localStorage.getItem(STORAGE_KEY)).toBe(localRaw)
  })

  it('keeps the documented stale-write limitation when Web Locks are unavailable', async () => {
    // Given no cross-tab lock capability, even if IndexedDB exists
    vi.stubGlobal('navigator', {})
    const readMirror = vi.spyOn(trustedMintsCommitStore, 'read').mockResolvedValue(null)
    const writeMirror = vi.spyOn(trustedMintsCommitStore, 'write').mockResolvedValue()
    localStorage.setItem(STORAGE_KEY, envelope([mint('remote.example')]))
    await addTrustedMint('first.example', KEY_A, {ownerId: OWNER_ID})

    // When a later unlocked mutation reads a stale view, then no false convergence is claimed
    localStorage.setItem(STORAGE_KEY, envelope([mint('remote.example')]))
    await addTrustedMint('second.example', KEY_B, {ownerId: OWNER_ID})

    expect(readTrustedMints(OWNER_ID).map((entry) => entry.server)).toEqual([
      'remote.example',
      'second.example',
    ])
    expect(readMirror).not.toHaveBeenCalled()
    expect(writeMirror).not.toHaveBeenCalled()
  })
})
