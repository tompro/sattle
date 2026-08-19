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

export type PollOptions = {
  // first delay between checks (doubles each round up to intervalCapMs)
  intervalMs?: number
  intervalCapMs?: number
  // total budget before giving up
  maxWaitMs?: number
}

const DEFAULT_POLL: Required<PollOptions> = {
  intervalMs: 1000,
  intervalCapMs: 5000,
  maxWaitMs: 120_000
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

// polls a LUD-21/LUD-25 verify endpoint until it reports settled, with
// backoff, inside a total time budget. A single failed check isn't fatal -
// the next round tries again. Returns the settled VerifyResult; throws on
// budget exhaustion.
export const pollVerifyUntilSettled = async (
  verifyUrl: string,
  poll: PollOptions,
  options: LnurlcashOptions
): Promise<VerifyResult> => {
  const {intervalMs, intervalCapMs, maxWaitMs} = {...DEFAULT_POLL, ...poll}
  const deadline = Date.now() + maxWaitMs
  let delay = intervalMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const result = await fetchInvoiceVerification(verifyUrl, options)
      if (result.settled) return result
      lastError = null
    } catch (err) {
      lastError = err
    }
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())))
    delay = Math.min(delay * 2, intervalCapMs)
  }
  if (lastError instanceof Error) {
    throw new Error(`Payment not confirmed: ${lastError.message}`)
  }
  throw new Error('Payment not confirmed within the time budget.')
}
