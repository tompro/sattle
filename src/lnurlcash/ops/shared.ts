// Shared plumbing for the operations engine: the bounded verify polling
// every flow that waits on a payment uses, and the uncertainty type a lost
// mutation answer surfaces as.

import {fetchInvoiceVerification, fetchNoteInfo, withNewK1} from 'lnurlcash-kit'
import type {LnurlcashOptions, VerifyResult} from 'lnurlcash-kit'
import {NoteSpentError, NoteUnknownError, noteDeclaredAmount} from 'lnurlcash-kit'
import type {NewBearer} from '../types'
import type {CarveResult} from './carve'

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
  // called by a carve the moment its mutation has LANDED server-side (the
  // inputs are burned, the outputs are known), before the flow moves on to
  // anything slow or uncertain - the caller's one chance to durably commit
  // the changeset so an abort during a long settlement wait can never
  // strand the outputs or leave burned inputs looking spendable. If it
  // rejects, the flow stops BEFORE anything further is spent and the
  // rejection propagates: the carve state is then landed-but-maybe-
  // uncommitted, which the caller must surface loudly. Never called for a
  // carve that mutated nothing.
  readonly onCarve?: (carve: CarveResult) => void | Promise<void>
}

export const assertFundOwner = (options: FundOperationOptions): void => {
  options.assertOwner?.()
}

// what probing a would-be mutation output can tell
export type OutputProbe = 'live' | 'absent' | 'unknown'

// A refused mutation can still have LANDED: the redeem callback is a GET
// and HTTP stacks retry GETs, so the service may have executed the first
// attempt and refused this one as an already-spent input (LUD-25 says a
// byte-identical retry SHOULD get the original success replayed; real
// mints refuse instead). The kit attaches the fresh output secrets to
// every service refusal (newSecretsOf) - so before believing a refusal,
// probe one would-be output: 'live' proves the mutation landed and the
// carried secrets are the only money left, 'absent' proves the refusal is
// genuine, 'unknown' keeps it genuinely ambiguous.
export const probeMutationOutput = async (
  noteUrl: string,
  secret: string,
  options: LnurlcashOptions = {},
): Promise<OutputProbe> => {
  try {
    await fetchNoteInfo(withNewK1(noteUrl, secret, noteDeclaredAmount(noteUrl) ?? 0), options)
    return 'live'
  } catch (err) {
    if (err instanceof NoteSpentError || err instanceof NoteUnknownError) return 'absent'
    return 'unknown'
  }
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

// polls `check` until it yields a value, with backoff, inside a total
// time budget. A single failed check isn't fatal - the next round tries
// again. Returns the first value; throws on budget exhaustion, or
// PollAbortedError when the caller's signal fires (a hung fetch is
// interrupted too: the signal is bound into the request).
export const pollUntil = async <T>(
  check: (options: LnurlcashOptions) => Promise<T | null>,
  exhausted: string,
  poll: PollOptions,
  options: LnurlcashOptions,
): Promise<T> => {
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
      const result = await check(fetchOptions)
      if (result !== null) return result
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
    throw new Error(`${exhausted}: ${lastError.message}`)
  }
  throw new Error(`${exhausted} within the time budget.`)
}

// polls a LUD-21/LUD-25 verify endpoint until it reports settled, with
// backoff, inside a total time budget. A single failed check isn't fatal -
// the next round tries again. Returns the settled VerifyResult; throws on
// budget exhaustion, or PollAbortedError when the caller's signal fires
// (a hung fetch is interrupted too: the signal is bound into the request).
export const pollVerifyUntilSettled = (
  verifyUrl: string,
  poll: PollOptions,
  options: LnurlcashOptions,
): Promise<VerifyResult> =>
  pollUntil(
    async (fetchOptions) => {
      const result = await fetchInvoiceVerification(verifyUrl, fetchOptions)
      return result.settled ? result : null
    },
    'Payment not confirmed',
    poll,
    options,
  )
