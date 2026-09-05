import {describe, expect, it, vi} from 'vitest'

import {StorageLocksUnavailableError, withRequiredStorageLock, withStorageLock} from './storageLock'

describe('withStorageLock fallback', () => {
  it('runs unlocked when Web Locks are unavailable without promising serialization', async () => {
    vi.stubGlobal('navigator', {})
    const entered: string[] = []
    let releaseFirst: (() => void) | undefined

    try {
      const first = withStorageLock('registry', async () => {
        entered.push('first')
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
      })
      const second = withStorageLock('registry', () => {
        entered.push('second')
      })

      await second
      expect(entered).toEqual(['first', 'second'])
      releaseFirst?.()
      await first
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('withRequiredStorageLock', () => {
  it('rejects before running the callback when Web Locks are unavailable', async () => {
    vi.stubGlobal('navigator', {})
    let ran = false
    try {
      await expect(
        withRequiredStorageLock('funds', () => {
          ran = true
        }),
      ).rejects.toBeInstanceOf(StorageLocksUnavailableError)
      expect(ran).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('serializes same-name callbacks across concurrent callers when locks exist', async () => {
    const entered: string[] = []
    let releaseFirst: (() => void) | undefined
    const first = withRequiredStorageLock('funds', async () => {
      entered.push('first')
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
    })
    const second = withRequiredStorageLock('funds', () => {
      entered.push('second')
    })

    await vi.waitFor(() => expect(entered).toEqual(['first']))
    releaseFirst?.()
    await Promise.all([first, second])
    expect(entered).toEqual(['first', 'second'])
  })
})
