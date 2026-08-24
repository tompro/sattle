import {describe, expect, it, vi} from 'vitest'
import {buildNoteUrl} from 'lnurlcash-kit'
import type {Bearer} from '../types'
import {deriveBearerAesKey} from '../keys'
import {deleteBearerRecord, newBearerId, persistBearer} from '../storage'
import {stubLocalStorage} from '../test-utils'

const LINKING_KEY = new Uint8Array(32).fill(7)
const K1 = 'aa'.repeat(32)
const bearerFixture = (): Bearer => ({
  id: newBearerId(),
  url: buildNoteUrl('https://mint.example/w', K1, 21_000),
  callback: 'https://mint.example/w/cb',
  amount: 21_000,
  verified: true,
  createdAt: 1000,
  updatedAt: 1000,
})
describe('baseline: per-record bearer persistence', () => {
  it('persistBearer/deleteBearerRecord perform one write per call', async () => {
    const storage = stubLocalStorage()
    const key = await deriveBearerAesKey(LINKING_KEY)
    const writes = vi.spyOn(storage, 'setItem')
    await persistBearer(key, {...bearerFixture(), id: 'a'})
    await persistBearer(key, {...bearerFixture(), id: 'b'})
    await deleteBearerRecord('a')
    expect(writes.mock.calls.filter(([keyName]) => keyName === 'sattle_bearers')).toHaveLength(3)
  })
})
