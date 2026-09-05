// Shared plumbing for the operations engine: the bounded verify polling
// every flow that waits on a payment uses, and the uncertainty type a lost
// mutation answer surfaces as.

import {
  fetchInvoiceVerification,
  fetchNoteInfo,
  noteK1,
  noteSignature,
  serverOf,
  verifyNoteSignature,
  withNewK1,
} from 'lnurlcash-kit'
import type {LnurlcashOptions, VerifyResult} from 'lnurlcash-kit'
import {NoteSpentError, NoteUnknownError, noteDeclaredAmount} from 'lnurlcash-kit'
import type {NewBearer} from '../types'
import type {CarveResult} from './carve'

// a mutation's answer was lost AND the probe could not tell whether it
// landed - the possible outputs the fresh secrets would control, for the
// caller to track unverified alongside the kept inputs. A pre-wire carve
// checkpoint may already have persisted them, in which case this list is
// empty so callers do not add duplicate records.
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
  // Two durable phases for a mutating carve. Before wire use, unverified
  // outputs are reported with `consumed: []`. After the mint mutation is
  // known to have landed, the already-staged note is reported again with
  // the inputs that can now be retired. A rejection in either phase stops
  // the flow; exact-note carves call neither phase.
  readonly onCarve?: (carve: CarveResult) => void | Promise<void>
  // the trusted signing keys a landed mutation output's signature is
  // checked against before it may report verified: the mint's pinned
  // current key AND its previous one (a just-rotated mint's last notes
  // stay verifiable). Production supplies the trusted-mint registry's
  // keys; an absent source (or empty list) keeps every landed output
  // staged unverified rather than trusting it blindly.
  readonly mintSignatureKeys?: MintSignatureKeys
}

// the trusted signing keys available for one mint server
export type MintSignatureKeys = (server: string) => readonly string[]

// The mutation safety policy, forced where the engine talks to a mint:
// every mutation must come back signed (the signature is the only offline
// proof the mint issued the output) and a lost answer is retried exactly
// once, byte-identically (the replay the pre-wire staging exists to make
// safe). Both are lnurlcash-kit's own defaults - restating them AFTER the
// caller spread means no caller's options object can quietly strip either
// guarantee.
export const withMutationSafety = <Options extends LnurlcashOptions>(options: Options): Options => ({
  ...options,
  requireSignatures: true,
  mutationRetries: 1,
})

// A landed mutation output earns verified:true only when its signature
// (carried as the URL's sig param) verifies against a trusted key for its
// server. Missing, malformed, or wrong-key signatures - or no trusted keys
// on file at all - leave the note staged unverified; a refresh can repair
// it later. The money is never at stake here (the note exists at the mint
// either way), only the offline-verifiable badge is.
export const landedNoteVerifies = (
  noteUrl: string,
  keysFor: MintSignatureKeys | undefined,
): boolean => {
  if (!keysFor) return false
  const k1 = noteK1(noteUrl)
  const amountMsat = noteDeclaredAmount(noteUrl)
  const signature = noteSignature(noteUrl)
  if (!k1 || amountMsat === null || !signature) return false
  const keys = keysFor(serverOf(noteUrl))
  return keys.length > 0 && verifyNoteSignature(k1, amountMsat, signature, [...keys])
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
