import {describe, expect, it} from 'vitest'
import {fetchNoteInfo, noteK1, noteSignature} from 'lnurlcash-kit'

import type {Bearer} from './types'
import type {CarveResult} from './ops'
import {CarveCheckpointRequiredError, UncertainOutcomeError, ensureExactAmount} from './ops'
import {requiredValue} from './test-utils'
import {makeBearer, mint, noteUrl, secret, signatureKeysFor} from './ops.testHarness'

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
    const result = await ensureExactAmount([bearer], 5_000, {
      onCarve: () => undefined,
      mintSignatureKeys: signatureKeysFor(instance),
    })
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
    const result = await ensureExactAmount([first, second], 7_000, {onCarve: () => undefined})
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
    const result = await ensureExactAmount([first, second], 5_000, {onCarve: () => undefined})
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
      verified: false,
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
    const result = await ensureExactAmount([bearer], 5_000, {onCarve: () => undefined})
    const partK1 = requiredValue(noteK1(result.note.url))
    const changeK1 = requiredValue(noteK1(requiredValue(result.change).url))
    expect(partK1).not.toBe(k1)
    expect(instance.state.noteState(k1)).toBe('burned')
    expect((await fetchNoteInfo(noteUrl(instance, partK1))).maxWithdrawable).toBe(5_000)
    expect((await fetchNoteInfo(noteUrl(instance, changeK1))).maxWithdrawable).toBe(16_000)
  })

  it('surfaces the possible outputs when neither mutation nor probe can be confirmed', async () => {
    const instance = await mint()
    const k1 = secret('11')
    const bearer = await makeBearer(instance, k1, 21_000)
    // every mutation answer is lost - the first attempt's AND the forced
    // byte-identical replay's (the mint executed both; the replay is the
    // recorded success served again, then dropped by the wrapper) - and
    // every informational probe is unreachable, so neither the mutation
    // nor the probe can be confirmed
    const everythingDyingFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/w/cb')) {
        const response = await fetch(input, init)
        await response.arrayBuffer()
        throw new Error('mutation response lost')
      }
      return Promise.reject(new Error('probe unreachable'))
    }
    const checkpoints: CarveResult[] = []
    const failure = await ensureExactAmount([bearer], 5_000, {
      fetch: everythingDyingFetch,
      onCarve: (carve) => {
        checkpoints.push(carve)
      },
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(UncertainOutcomeError)
    if (!(failure instanceof UncertainOutcomeError)) throw failure
    expect(failure.possibleOutputs).toEqual([])
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]?.consumed).toEqual([])
    expect(checkpoints[0]?.note.amount).toBe(5_000)
    expect(checkpoints[0]?.change?.amount).toBe(16_000)
  })

  it('stages outputs before wire and retires inputs only after the mutation lands', async () => {
    const instance = await mint()
    const bearer = await makeBearer(instance, secret('12'), 21_000)
    const seen: CarveResult[] = []
    const result = await ensureExactAmount([bearer], 5_000, {
      onCarve: (carve) => {
        seen.push(carve)
      },
      mintSignatureKeys: signatureKeysFor(instance),
    })
    expect(seen).toHaveLength(2)
    expect(seen[0]?.note.verified).toBe(false)
    expect(seen[0]?.consumed).toEqual([])
    expect(seen[0]?.change).toBeDefined()
    expect(noteK1(requiredValue(seen[0]).note.url)).toBe(noteK1(result.note.url))
    expect(noteK1(requiredValue(requiredValue(seen[0]).change).url)).toBe(
      noteK1(requiredValue(result.change).url),
    )
    // the landed checkpoint re-reports the SAME staged output (same secret)
    // - its URL has since gained the mint's signature
    expect(noteK1(requiredValue(seen[1]).note.url)).toBe(noteK1(requiredValue(seen[0]).note.url))
    expect(noteSignature(requiredValue(seen[1]).note.url)).not.toBeNull()
    expect(seen[1]?.note.verified).toBe(true)
    expect(seen[1]?.change).toBeUndefined()
    expect(seen[1]?.consumed).toEqual(result.consumed)
    expect(result.consumed).toHaveLength(1)
  })

  it('does not stage the split change again during the landed checkpoint', async () => {
    const instance = await mint()
    const bearer = await makeBearer(instance, secret('17'), 21_000)
    const trackedSecrets = new Set<string>()
    const retiredIds = new Set<string>()

    const result = await ensureExactAmount([bearer], 5_000, {
      onCarve: (carve) => {
        // checkpoints identify an output by its secret: the landed phase's
        // URL has gained a signature the staged phase could not have had
        const k1 = noteK1(carve.note.url)
        if (k1) trackedSecrets.add(k1)
        const changeK1 = carve.change ? noteK1(carve.change.url) : null
        if (changeK1) trackedSecrets.add(changeK1)
        for (const consumed of carve.consumed) retiredIds.add(consumed.id)
      },
    })

    expect(trackedSecrets).toEqual(
      new Set([
        requiredValue(noteK1(result.note.url)),
        requiredValue(noteK1(requiredValue(result.change).url)),
      ]),
    )
    expect(retiredIds).toEqual(new Set([bearer.id]))
  })

  it('keeps staged outputs recoverable when the landed checkpoint fails', async () => {
    const instance = await mint()
    const sourceSecret = secret('15')
    const bearer = await makeBearer(instance, sourceSecret, 21_000)
    const seen: CarveResult[] = []

    await expect(
      ensureExactAmount([bearer], 5_000, {
        onCarve: (carve) => {
          seen.push(carve)
          if (carve.consumed.length > 0) throw new Error('final commit failed')
        },
      }),
    ).rejects.toThrow(/final commit failed/)

    expect(seen).toHaveLength(2)
    expect(seen[0]?.consumed).toEqual([])
    expect(seen[0]?.change).toBeDefined()
    expect(instance.state.noteState(sourceSecret)).toBe('burned')
    expect(instance.state.noteState(requiredValue(noteK1(requiredValue(seen[0]).note.url)))).toBe(
      'outstanding',
    )
    expect(
      instance.state.noteState(
        requiredValue(noteK1(requiredValue(requiredValue(seen[0]).change).url)),
      ),
    ).toBe('outstanding')
  })

  it('never fires onCarve for an already-exact note - nothing was burned', async () => {
    const instance = await mint()
    const bearer = await makeBearer(instance, secret('13'), 21_000)
    let called = false
    const result = await ensureExactAmount([bearer], 21_000, {
      onCarve: () => {
        called = true
      },
    })
    expect(called).toBe(false)
    expect(result.consumed).toEqual([])
  })

  it('requires a typed durable checkpoint before a mutating carve', async () => {
    const instance = await mint()
    const bearer = await makeBearer(instance, secret('16'), 21_000)

    await expect(ensureExactAmount([bearer], 5_000)).rejects.toBeInstanceOf(
      CarveCheckpointRequiredError,
    )
    expect(instance.state.noteState(secret('16'))).toBe('outstanding')
  })

  it('propagates an onCarve failure before the carve reaches the mint', async () => {
    const instance = await mint()
    const bearer = await makeBearer(instance, secret('14'), 21_000)
    await expect(
      ensureExactAmount([bearer], 5_000, {
        onCarve: () => {
          throw new Error('commit failed')
        },
      }),
    ).rejects.toThrow(/commit failed/)
    expect(instance.state.noteState(secret('14'))).toBe('outstanding')
  })

  it('draws the split outputs from the caller allocation path, exactly two', async () => {
    const instance = await mint()
    const bearer = await makeBearer(instance, secret('80'), 21_000)
    const allocations: Array<{server: string; count: number}> = []
    const allocated = [secret('81'), secret('82')]

    const result = await ensureExactAmount([bearer], 5_000, {
      onCarve: () => undefined,
      allocateOutputSecrets: (server, count) => {
        allocations.push({server, count})
        return Promise.resolve(allocated.slice(0, count))
      },
    })

    expect(allocations).toEqual([{server: `127.0.0.1:${instance.port}`, count: 2}])
    expect(noteK1(result.note.url)).toBe(allocated[0])
    expect(noteK1(requiredValue(result.change).url)).toBe(allocated[1])
  })

  it('draws the merge output from the caller allocation path, exactly one', async () => {
    const instance = await mint()
    const first = await makeBearer(instance, secret('83'), 3_000)
    const second = await makeBearer(instance, secret('84'), 4_000)
    const allocations: Array<{server: string; count: number}> = []
    const allocated = [secret('85')]

    const result = await ensureExactAmount([first, second], 7_000, {
      onCarve: () => undefined,
      allocateOutputSecrets: (server, count) => {
        allocations.push({server, count})
        return Promise.resolve(allocated.slice(0, count))
      },
    })

    expect(allocations).toEqual([{server: `127.0.0.1:${instance.port}`, count: 1}])
    expect(noteK1(result.note.url)).toBe(allocated[0])
  })

  it('allocates nothing when one note already holds the exact amount', async () => {
    const instance = await mint()
    const bearer = await makeBearer(instance, secret('86'), 21_000)
    let allocations = 0

    await ensureExactAmount([bearer], 21_000, {
      allocateOutputSecrets: () => {
        allocations += 1
        return Promise.resolve([])
      },
    })

    expect(allocations).toBe(0)
  })
})
