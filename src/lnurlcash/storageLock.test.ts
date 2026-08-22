import {describe, expect, it, vi} from 'vitest'

import {withStorageLock} from './storageLock'

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
