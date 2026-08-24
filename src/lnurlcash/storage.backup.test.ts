// Backup restore waits for owner-bound trusted-mint convergence before it
// reports success, while retaining the hostile-file merge policy.

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {linkingPubKeyHex, saveLinkingKey} from './keys'
import {applyBackup, buildBackup} from './storage'
import {addTrustedMint, readTrustedMints} from './trustedMints'
import {stubLocalStorage} from './test-utils'

const LINKING_KEY = new Uint8Array(32).fill(7)
const OWNER_ID = linkingPubKeyHex(LINKING_KEY)
const KEY_A = '02' + 'aa'.repeat(32)
const KEY_B = '03' + 'bb'.repeat(32)

type LockRequest = {
  readonly callback: () => unknown
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
}

class DeferredLocks {
  readonly requests: LockRequest[] = []

  readonly request = (_name: string, callback: () => unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      this.requests.push({callback, resolve, reject})
    })

  async releaseNext(): Promise<void> {
    const request = this.requests.shift()
    if (!request) throw new Error('Expected a queued lock request.')
    try {
      request.resolve(await request.callback())
    } catch (error) {
      request.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

const backup = (server: string, mintPubkey: string) => ({
  type: 'sattle-backup' as const,
  version: 1 as const,
  createdAt: 1,
  bearers: [],
  trustedMints: [
    {
      server,
      mintPubkey,
      addedAt: 1,
      locked: true,
      pendingMintPubkey: KEY_B,
    },
  ],
})

const installProvenOwner = (): Promise<void> => saveLinkingKey(LINKING_KEY)

beforeEach(() => {
  vi.unstubAllGlobals()
  stubLocalStorage()
})

describe('owner-bound backup restore', () => {
  it('exports only the active owner trusted-mint registry', async () => {
    await installProvenOwner()
    await addTrustedMint('backup-mint.example', KEY_A, {ownerId: OWNER_ID})

    expect(buildBackup(OWNER_ID).trustedMints).toEqual([
      expect.objectContaining({server: 'backup-mint.example', mintPubkey: KEY_A}),
    ])
    expect(buildBackup(OWNER_ID).ownerId).toBe(OWNER_ID)
    expect(buildBackup().trustedMints).toEqual([])
  })

  it('drops fresh-device mint trust instead of using a valid file owner marker', async () => {
    const result = await applyBackup({
      ...backup('file-mint.example', KEY_A),
      ownerId: OWNER_ID,
    })

    expect(result.trustedMintsAdded).toBe(0)
    expect(readTrustedMints(OWNER_ID)).toEqual([])
    expect(localStorage.getItem('sattle_trusted_mints')).toBeNull()
  })

  it('does not attach file mints to a malformed owner marker', async () => {
    const result = await applyBackup({
      ...backup('file-mint.example', KEY_A),
      ownerId: 'malformed-owner',
    })

    expect(result.trustedMintsAdded).toBe(0)
    expect(readTrustedMints(OWNER_ID)).toEqual([])
  })

  it('does not resolve before the trusted-mint merge commits', async () => {
    await installProvenOwner()
    const locks = new DeferredLocks()
    vi.stubGlobal('navigator', {locks})

    let settled = false
    const restoring = applyBackup(backup('backup-mint.example', KEY_A), OWNER_ID).then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() => expect(locks.requests).toHaveLength(1))

    expect(settled).toBe(false)
    await locks.releaseNext()

    expect((await restoring).trustedMintsAdded).toBe(1)
    const restored = readTrustedMints(OWNER_ID)
    expect(restored).toEqual([
      expect.objectContaining({
        server: 'backup-mint.example',
        mintPubkey: KEY_A,
        locked: false,
        unconfirmed: true,
      }),
    ])
    expect(restored[0]?.pendingMintPubkey).toBeUndefined()
  })

  it('keeps a local locked pin and pending rekey authoritative', async () => {
    await installProvenOwner()
    localStorage.setItem(
      'sattle_trusted_mints',
      JSON.stringify({
        version: 1,
        ownerId: OWNER_ID,
        mints: [
          {
            server: 'local.example',
            mintPubkey: KEY_A,
            addedAt: 1,
            locked: true,
            pendingMintPubkey: KEY_B,
          },
        ],
      }),
    )

    const result = await applyBackup(backup('local.example', KEY_B), OWNER_ID)

    expect(result.trustedMintsAdded).toBe(0)
    expect(readTrustedMints(OWNER_ID)).toEqual([
      expect.objectContaining({
        mintPubkey: KEY_A,
        locked: true,
        pendingMintPubkey: KEY_B,
      }),
    ])
  })
})
