// Paying over Lightning: melt held notes into a bolt11 invoice or a
// Lightning Address payment. melt demands an exact amount match and takes
// a single k1, so the notes are carved first (see carve.ts's
// ensureExactAmount).

import {
  AmbiguousMutationError,
  NoteSpentError,
  PendingNoteError,
  decodeBolt11AmountMsat,
  defaultRandomSecret,
  fetchPayRequest,
  isBolt11Invoice,
  meltNote,
  requestInvoice,
  requireNoteK1,
  resolveLnurlInput,
  rotateNote,
  sameInvoice,
  withNewK1,
} from 'lnurlcash-kit'
import type {LnurlcashOptions, MeltResult} from 'lnurlcash-kit'
import type {Bearer, NewBearer} from '../types'
import type {CarveResult} from './carve'
import {ensureExactAmount} from './carve'
import type {PollOptions} from './shared'
import type {FundOperationOptions} from './shared'
import {assertFundOwner, pollVerifyUntilSettled, withMutationSafety} from './shared'

export type PayOutcome =
  | 'settled'
  | 'failed-funds-returned'
  | 'unknown-still-pending'
  // the service reports the carved note as already spent before the melt
  // even started - nothing was paid, and the note is definitively gone
  | 'note-already-spent'

export type PayResult = {
  outcome: PayOutcome
  carve: CarveResult
  // the invoice that was (attempted to be) paid
  invoice: string
  amountMsat: number
  verifyUrl: string | null
  rotatedNote?: NewBearer
  rescuedNote?: NewBearer
}

export type PayOptions = {
  // required when `input` is a Lightning Address / LNURL-pay (a bolt11
  // carries its own amount)
  amountMsat?: number
  // verify-poll budget - tests shrink this
  poll?: PollOptions
  // kit transport overrides (fetch injection, timeouts)
  kit?: LnurlcashOptions
  assertOwner?: () => void
  // carve checkpoint - committed before the melt and the settlement wait,
  // so an abort mid-wait never strands the carve (see
  // FundOperationOptions.onCarve)
  onCarve?: FundOperationOptions['onCarve']
  // Called before the classification rotate puts its chosen output secret
  // on the wire. Production callers durably link it to the carved source.
  onReturnReady?: (carve: CarveResult, recoverySecret: string) => void | Promise<void>
}

// A melt's resolved promise only means the payment is in flight; the
// outcome is classified by polling the melt's LUD-25 verify URL, then - if
// that budget runs out - by attempting a rotate on the melted note (a
// failed melt is never reported through the callback; it is only
// observable as the note becoming spendable again, which a rotate proves
// by succeeding - and rotates, since the melt put k1 on the wire anyway):
// - settled: the payment went through; the note is gone for good
// - failed-funds-returned: the note was spendable again, nothing was paid
// - unknown-still-pending: neither confirmed; the note stays locked spent
//   locally until a refresh reconciles it
export const payWithBearers = async (
  bearers: Bearer[],
  input: string,
  {amountMsat, poll = {}, kit = {}, assertOwner, onCarve, onReturnReady}: PayOptions = {},
): Promise<PayResult> => {
  // the forced mutation policy (see shared.ts) covers the carve, the melt,
  // and the classification rotate regardless of caller kit options
  const options: FundOperationOptions = withMutationSafety({
    ...kit,
    ...(assertOwner ? {assertOwner} : {}),
    ...(onCarve ? {onCarve} : {}),
  })
  let invoice: string
  let amount: number
  const trimmed = input.trim()
  if (isBolt11Invoice(trimmed)) {
    const decoded = decodeBolt11AmountMsat(trimmed)
    if (decoded === null || decoded <= 0) {
      throw new Error(
        "Could not read this invoice's amount - amount-less invoices are not supported.",
      )
    }
    invoice = trimmed
    amount = decoded
  } else {
    // a Lightning Address (or LNURL-pay) has no invoice of its own yet -
    // resolving it gets a payRequest, and an amount is needed before an
    // actual invoice exists
    const url = resolveLnurlInput(trimmed)
    if (!url) {
      throw new Error('Not a valid bolt11 invoice or Lightning Address.')
    }
    if (amountMsat === undefined || !Number.isInteger(amountMsat) || amountMsat <= 0) {
      throw new Error('Enter an amount to pay to this address.')
    }
    const info = await fetchPayRequest(url, options)
    if (amountMsat < info.minSendable || amountMsat > info.maxSendable) {
      throw new Error("Amount is outside the payee's sendable range.")
    }
    const result = await requestInvoice(info.callback, amountMsat, options)
    invoice = result.pr
    amount = amountMsat
  }

  const carve = await ensureExactAmount(bearers, amount, options)
  const k1 = requireNoteK1(carve.note.url)
  if (carve.consumed.length === 0) assertFundOwner(options)
  let melt: MeltResult
  try {
    melt = await meltNote(carve.note.callback, k1, invoice, options)
  } catch (err) {
    // this melt names a single note, so a NoteSpentError here is
    // unambiguous - it's already gone, and gets locked spent the same way
    // a successful melt would have locked it
    if (err instanceof NoteSpentError) {
      return {outcome: 'note-already-spent', carve, invoice, amountMsat: amount, verifyUrl: null}
    }
    throw err
  }

  if (!melt.verify) {
    // no melt proof to poll - the note locking as spent locally is all the
    // confirmation there is
    return {outcome: 'unknown-still-pending', carve, invoice, amountMsat: amount, verifyUrl: null}
  }
  const verifyUrl = melt.verify
  try {
    const proof = await pollVerifyUntilSettled(verifyUrl, poll, options)
    // a settled report is only this payment's proof when it's for the
    // invoice this melt actually paid - a mint that mixes up proofs must
    // not confirm the wrong payment. The verify URL is already scoped to
    // this melt's payment hash, so an exact string match binds it; short
    // of that, a proof pr that decodes to a DIFFERENT amount definitely
    // belongs to another payment, while an undecodable one says nothing
    // either way (a service regenerating synthetic prs in proofs) and is
    // tolerated.
    const proofAmount = decodeBolt11AmountMsat(proof.pr)
    if (!sameInvoice(proof.pr, invoice) && proofAmount !== null && proofAmount !== amount) {
      return {outcome: 'unknown-still-pending', carve, invoice, amountMsat: amount, verifyUrl}
    }
    return {outcome: 'settled', carve, invoice, amountMsat: amount, verifyUrl}
  } catch {
    // The verify budget ran out. Journal the exact output secret before the
    // classification rotate reaches the mint, so a crash can recover either
    // the returned source or the rotated replacement.
    const recoverySecret = kit.randomSecret?.() ?? defaultRandomSecret()
    await onReturnReady?.(carve, recoverySecret)
    try {
      const rotated = await rotateNote(carve.note.callback, k1, {
        ...options,
        randomSecret: () => recoverySecret,
      })
      return {
        outcome: 'failed-funds-returned',
        carve,
        rotatedNote: {
          url: withNewK1(carve.note.url, recoverySecret, amount, rotated.signature),
          callback: carve.note.callback,
          amount,
          verified: true,
          ...(carve.note.mintPubkey ? {mintPubkey: carve.note.mintPubkey} : {}),
        },
        invoice,
        amountMsat: amount,
        verifyUrl,
      }
    } catch (err) {
      if (err instanceof PendingNoteError) {
        return {outcome: 'unknown-still-pending', carve, invoice, amountMsat: amount, verifyUrl}
      }
      if (err instanceof NoteSpentError) {
        return {outcome: 'settled', carve, invoice, amountMsat: amount, verifyUrl}
      }
      if (err instanceof AmbiguousMutationError) {
        const rescuedNote: NewBearer = {
          url: withNewK1(carve.note.url, recoverySecret, amount),
          callback: carve.note.callback,
          amount,
          verified: false,
        }
        if (carve.note.mintPubkey) rescuedNote.mintPubkey = carve.note.mintPubkey
        return {
          outcome: 'failed-funds-returned',
          carve,
          invoice,
          amountMsat: amount,
          verifyUrl,
          rescuedNote,
        }
      }
      return {outcome: 'unknown-still-pending', carve, invoice, amountMsat: amount, verifyUrl}
    }
  }
}
