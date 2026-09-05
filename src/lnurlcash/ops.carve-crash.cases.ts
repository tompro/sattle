import {describe, expect, it} from 'vitest'
import {noteK1} from 'lnurlcash-kit'

import type {CarveResult} from './ops'
import {ensureExactAmount, UnsupportedMultiBatchMergeError} from './ops'
import {requiredValue} from './test-utils'
import {makeBearer, mint, secret} from './ops.testHarness'

const secretSource = (...secrets: string[]): (() => string) => {
  let index = 0
  return () => {
    const next = secrets[index]
    if (!next) throw new Error('The test exhausted its prepared secrets.')
    index += 1
    return next
  }
}

describe('ensureExactAmount crash safety', () => {
  it('stages both split secrets before either hash reaches the mint', async () => {
    const instance = await mint()
    const sourceSecret = secret('70')
    const targetSecret = secret('71')
    const changeSecret = secret('72')
    const bearer = await makeBearer(instance, sourceSecret, 21_000)
    let staged: CarveResult | undefined
    const observingFetch: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/w/cb')) {
        expect(staged).toBeDefined()
        expect(noteK1(requiredValue(staged).note.url)).toBe(targetSecret)
        expect(noteK1(requiredValue(requiredValue(staged).change).url)).toBe(changeSecret)
        expect(instance.state.noteState(sourceSecret)).toBe('outstanding')
      }
      return fetch(input, init)
    }

    const result = await ensureExactAmount([bearer], 5_000, {
      fetch: observingFetch,
      randomSecret: secretSource(targetSecret, changeSecret),
      onCarve: (prepared) => {
        staged = prepared
      },
    })

    expect(result.consumed.map((entry) => entry.id)).toEqual([bearer.id])
  })

  it('stages the merge secret before its hash reaches the mint', async () => {
    const instance = await mint()
    const firstSecret = secret('73')
    const secondSecret = secret('74')
    const mergedSecret = secret('75')
    const first = await makeBearer(instance, firstSecret, 3_000)
    const second = await makeBearer(instance, secondSecret, 4_000)
    let staged: CarveResult | undefined
    const observingFetch: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/w/cb')) {
        expect(staged).toBeDefined()
        expect(noteK1(requiredValue(staged).note.url)).toBe(mergedSecret)
        expect(instance.state.noteState(firstSecret)).toBe('outstanding')
        expect(instance.state.noteState(secondSecret)).toBe('outstanding')
      }
      return fetch(input, init)
    }

    await ensureExactAmount([first, second], 7_000, {
      fetch: observingFetch,
      randomSecret: secretSource(mergedSecret),
      onCarve: (prepared) => {
        staged = prepared
      },
    })

    expect(staged?.consumed.map((entry) => entry.id)).toEqual([first.id, second.id])
  })

  it('does not expose a staged split output to a second ambiguous rotation', async () => {
    const instance = await mint()
    const bearer = await makeBearer(instance, secret('76'), 21_000)
    let mutationCount = 0
    const dropSecondMutation: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.includes('/w/cb')) return fetch(input, init)
      mutationCount += 1
      const response = await fetch(input, init)
      if (mutationCount === 2) {
        await response.arrayBuffer()
        throw new Error('second mutation response lost')
      }
      return response
    }

    const result = await ensureExactAmount([bearer], 5_000, {
      fetch: dropSecondMutation,
      mutationRetries: 0,
      randomSecret: secretSource(secret('77'), secret('78')),
      onCarve: () => undefined,
    })

    expect(mutationCount).toBe(1)
    const targetSecret = requiredValue(noteK1(result.note.url))
    const changeSecret = requiredValue(noteK1(requiredValue(result.change).url))
    expect(instance.state.noteState(targetSecret)).toBe('outstanding')
    expect(instance.state.noteState(changeSecret)).toBe('outstanding')
  })

  it('rejects a multi-batch merge before any partial fold can land', async () => {
    const instance = await mint()
    const bearers = await Promise.all(
      Array.from({length: 21}, (_, index) =>
        makeBearer(instance, secret((128 + index).toString(16)), 1_000),
      ),
    )
    let mutationCount = 0
    const countingFetch: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/w/cb')) mutationCount += 1
      return fetch(input, init)
    }

    const failure = ensureExactAmount(bearers, 21_000, {
      fetch: countingFetch,
      onCarve: () => undefined,
    })
    await expect(failure).rejects.toBeInstanceOf(UnsupportedMultiBatchMergeError)
    expect(mutationCount).toBe(0)
    expect(
      bearers.every(
        (bearer) => instance.state.noteState(requiredValue(noteK1(bearer.url))) === 'outstanding',
      ),
    ).toBe(true)
  })

  it('checks ownership again immediately before a merge mutation', async () => {
    const instance = await mint()
    const firstSecret = secret('79')
    const secondSecret = secret('7a')
    const first = await makeBearer(instance, firstSecret, 3_000)
    const second = await makeBearer(instance, secondSecret, 4_000)
    let ownerChecks = 0
    let mutationCount = 0
    const countingFetch: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/w/cb')) mutationCount += 1
      return fetch(input, init)
    }

    await expect(
      ensureExactAmount([first, second], 7_000, {
        fetch: countingFetch,
        assertOwner: () => {
          ownerChecks += 1
          if (ownerChecks === 3) throw new Error('wallet owner changed')
        },
        onCarve: () => undefined,
      }),
    ).rejects.toThrow(/owner changed/)

    expect(mutationCount).toBe(0)
    expect(instance.state.noteState(firstSecret)).toBe('outstanding')
    expect(instance.state.noteState(secondSecret)).toBe('outstanding')
  })
})
