import {describe, expect, it} from 'vitest'
import {fetchNoteInfo, noteK1} from 'lnurlcash-kit'

import type {Bearer} from './types'
import {UncertainOutcomeError, ensureExactAmount} from './ops'
import {requiredValue} from './test-utils'
import {makeBearer, mint, noteUrl, secret} from './ops.testHarness'

describe('ensureExactAmount', () => {
  it('returns an already-exact note untouched, burning nothing', async () => {
    const instance = await mint()
    const k1 = secret('01')
    const bearer = await makeBearer(instance, k1, 21_000)
    const result = await ensureExactAmount([bearer], 21_000)
    expect(noteK1(result.note.url)).toBe(k1)
    expect(result.consumed).toEqual([])
    expect(result.change).toBeUndefined()
    expect(instance.state.noteState(k1)).toBe('outstanding')
  })

  it('split path: carves an exact note off a larger one, with change', async () => {
    const instance = await mint()
    const k1 = secret('02')
    const bearer = await makeBearer(instance, k1, 21_000)
    const result = await ensureExactAmount([bearer], 5_000)
    expect(result.note.amount).toBe(5_000)
    expect(result.note.verified).toBe(true)
    expect(result.change?.amount).toBe(16_000)
    expect(result.consumed.map((entry) => entry.id)).toEqual([bearer.id])
    expect(instance.state.noteState(k1)).toBe('burned')
    const partK1 = requiredValue(noteK1(result.note.url))
    const changeK1 = requiredValue(noteK1(requiredValue(result.change).url))
    expect((await fetchNoteInfo(noteUrl(instance, partK1))).maxWithdrawable).toBe(5_000)
    expect((await fetchNoteInfo(noteUrl(instance, changeK1))).maxWithdrawable).toBe(16_000)
  })

  it('merge path: combines notes summing exactly to the target', async () => {
    const instance = await mint()
    const first = await makeBearer(instance, secret('03'), 3_000)
    const second = await makeBearer(instance, secret('04'), 4_000)
    const result = await ensureExactAmount([first, second], 7_000)
    expect(result.note.amount).toBe(7_000)
    expect(result.change).toBeUndefined()
    expect(result.consumed).toHaveLength(2)
    expect(instance.state.noteState(requiredValue(noteK1(first.url)))).toBe('burned')
    expect(instance.state.noteState(requiredValue(noteK1(second.url)))).toBe('burned')
    const mergedK1 = requiredValue(noteK1(result.note.url))
    expect((await fetchNoteInfo(noteUrl(instance, mergedK1))).maxWithdrawable).toBe(7_000)
  })

  it('merge+split path: splits the target off several notes in one request', async () => {
    const instance = await mint()
    const first = await makeBearer(instance, secret('05'), 3_000)
    const second = await makeBearer(instance, secret('06'), 4_000)
    const result = await ensureExactAmount([first, second], 5_000)
    expect(result.note.amount).toBe(5_000)
    expect(result.change?.amount).toBe(2_000)
    expect(result.consumed).toHaveLength(2)
    const partK1 = requiredValue(noteK1(result.note.url))
    const changeK1 = requiredValue(noteK1(requiredValue(result.change).url))
    expect((await fetchNoteInfo(noteUrl(instance, partK1))).maxWithdrawable).toBe(5_000)
    expect((await fetchNoteInfo(noteUrl(instance, changeK1))).maxWithdrawable).toBe(2_000)
  })

  it('excludes spent and unverified notes from selection', async () => {
    const instance = await mint()
    const spentBearer = await makeBearer(instance, secret('07'), 50_000)
    const unverified: Bearer = {
      ...(await makeBearer(instance, secret('08'), 50_000)),
      callback: '',
    }
    await expect(
      ensureExactAmount([{...spentBearer, spent: true}, unverified], 5_000),
    ).rejects.toThrow(/enough/)
  })

  it('refuses an amount no mint can cover', async () => {
    const instance = await mint()
    const bearer = await makeBearer(instance, secret('09'), 5_000)
    await expect(ensureExactAmount([bearer], 50_000)).rejects.toThrow(/enough/)
  })

  it("rescues the fresh secrets when a split's answer is lost (probe: gone)", async () => {
    const instance = await mint({dropAfterMutation: true})
    const k1 = secret('10')
    const bearer = await makeBearer(instance, k1, 21_000)
    const result = await ensureExactAmount([bearer], 5_000)
    const partK1 = requiredValue(noteK1(result.note.url))
    const changeK1 = requiredValue(noteK1(requiredValue(result.change).url))
    expect(partK1).not.toBe(k1)
    expect(instance.state.noteState(k1)).toBe('burned')
    expect((await fetchNoteInfo(noteUrl(instance, partK1))).maxWithdrawable).toBe(5_000)
    expect((await fetchNoteInfo(noteUrl(instance, changeK1))).maxWithdrawable).toBe(16_000)
  })

  it('surfaces the possible outputs when neither mutation nor probe can be confirmed', async () => {
    const instance = await mint({dropAfterMutation: true})
    const k1 = secret('11')
    const bearer = await makeBearer(instance, k1, 21_000)
    const probeKillingFetch: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/w/cb')) return fetch(input, init)
      return Promise.reject(new Error('probe unreachable'))
    }
    const failure = await ensureExactAmount([bearer], 5_000, {
      fetch: probeKillingFetch,
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(UncertainOutcomeError)
    if (!(failure instanceof UncertainOutcomeError)) throw failure
    expect(failure.possibleOutputs).toHaveLength(2)
    const first = requiredValue(failure.possibleOutputs[0])
    const second = requiredValue(failure.possibleOutputs[1])
    expect(first.amount).toBe(5_000)
    expect(second.amount).toBe(16_000)
    expect(
      (await fetchNoteInfo(noteUrl(instance, requiredValue(noteK1(first.url))))).maxWithdrawable,
    ).toBe(5_000)
    expect(
      (await fetchNoteInfo(noteUrl(instance, requiredValue(noteK1(second.url))))).maxWithdrawable,
    ).toBe(16_000)
  })
})
