// Shared plumbing for the operations engine: the bounded verify polling
// every flow that waits on a payment uses, and the uncertainty type a lost
// mutation answer surfaces as.

import {fetchInvoiceVerification} from 'lnurlcash-kit'
import type {LnurlcashOptions, VerifyResult} from 'lnurlcash-kit'
import type {NewBearer} from '../types'

// a mutation's answer was lost AND the probe could not tell whether it
// landed - the possible outputs the fresh secrets would control, for the
// caller to track unverified alongside the (kept) inputs. Never dropped:
// if the mutation did land, these are the only money left.
export class UncertainOutcomeError extends Error {
  readonly possibleOutputs: NewBearer[]
  constructor(message: string, possibleOutputs: NewBearer[]) {
    super(message)
    this.name = 'UncertainOutcomeError'
    this.possibleOutputs = possibleOutputs
  }
}

// the wait was interrupted from outside (service shutdown) - distinct
// from budget exhaustion so the caller can treat it as normal teardown
export class PollAbortedError extends Error {
  constructor() {
    super('The wait was interrupted by shutdown.')
    this.name = 'PollAbortedError'
  }
}

export type FundOperationOptions = LnurlcashOptions & {
  readonly assertOwner?: () => void
}

export const assertFundOwner = (options: FundOperationOptions): void => {
  options.assertOwner?.()
}

export type PollOptions = {
  // first delay between checks (doubles each round up to intervalCapMs)
  intervalMs?: number
  intervalCapMs?: number
  // total budget before giving up
  maxWaitMs?: number
  // aborts the wait promptly (shutdown). Only the WAIT is interruptible:
  // callers pass this for work whose observation phase may outlive the
  // caller - once pollVerifyUntilSettled has returned, the signal no
  // longer reaches anything
  signal?: AbortSignal
}

const DEFAULT_POLL: Required<Omit<PollOptions, 'signal'>> = {
  intervalMs: 1000,
  intervalCapMs: 5000,
  maxWaitMs: 120_000,
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// a sleep that ends immediately on abort instead of riding out its timer
const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new PollAbortedError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal.aborted) {
      clearTimeout(timer)
      reject(new PollAbortedError())
      return
    }
    signal.addEventListener('abort', onAbort, {once: true})
  })

// polls a LUD-21/LUD-25 verify endpoint until it reports settled, with
// backoff, inside a total time budget. A single failed check isn't fatal -
// the next round tries again. Returns the settled VerifyResult; throws on
// budget exhaustion, or PollAbortedError when the caller's signal fires
// (a hung fetch is interrupted too: the signal is bound into the request).
export const pollVerifyUntilSettled = async (
  verifyUrl: string,
  poll: PollOptions,
  options: LnurlcashOptions,
): Promise<VerifyResult> => {
  const {intervalMs, intervalCapMs, maxWaitMs, signal} = {
    ...DEFAULT_POLL,
    ...poll,
  }
  const fetchOptions: LnurlcashOptions = signal
    ? {
        ...options,
        fetch: (input, init) => {
          const base = options.fetch ?? globalThis.fetch
          return base(input, {...init, signal})
        },
      }
    : options
  const deadline = Date.now() + maxWaitMs
  let delay = intervalMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new PollAbortedError()
    try {
      const result = await fetchInvoiceVerification(verifyUrl, fetchOptions)
      if (result.settled) return result
      lastError = null
    } catch (err) {
      // the signal's own AbortError lands here on an interrupted fetch
      if (signal?.aborted) throw new PollAbortedError()
      lastError = err
    }
    if (signal) await abortableSleep(Math.min(delay, Math.max(0, deadline - Date.now())), signal)
    else await sleep(Math.min(delay, Math.max(0, deadline - Date.now())))
    delay = Math.min(delay * 2, intervalCapMs)
  }
  if (lastError instanceof Error) {
    throw new Error(`Payment not confirmed: ${lastError.message}`)
  }
  throw new Error('Payment not confirmed within the time budget.')
}
