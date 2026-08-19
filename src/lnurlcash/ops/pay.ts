// Paying over Lightning: melt held notes into a bolt11 invoice or a
// Lightning Address payment. melt demands an exact amount match and takes
// a single k1, so the notes are carved first (see carve.ts's
// ensureExactAmount).

import {
  AmbiguousMutationError,
  NoteSpentError,
  PendingNoteError,
  decodeBolt11AmountMsat,
  fetchPayRequest,
  isBolt11Invoice,
  meltNote,
  requestInvoice,
  requireNoteK1,
  resolveLnurlInput,
  rotateNote,
  sameInvoice,
  withNewK1
} from 'lnurlcash-kit'
import type {LnurlcashOptions, MeltResult} from 'lnurlcash-kit'
import type {Bearer, NewBearer} from '../types'
import type {CarveResult} from './carve'
import {ensureExactAmount} from './carve'
import type {PollOptions} from './shared'
import {pollVerifyUntilSettled} from './shared'

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
  // a fresh secret rescued from an ambiguous rotate during outcome
  // classification - the caller must track it unverified; if the rotate
  // landed, this is the only copy of the (returned) funds
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
  {amountMsat, poll = {}, kit = {}}: PayOptions = {}
): Promise<PayResult> => {
  const options = kit
  let invoice: string
  let amount: number
  const trimmed = input.trim()
  if (isBolt11Invoice(trimmed)) {
    const decoded = decodeBolt11AmountMsat(trimmed)
    if (decoded === null || decoded <= 0) {
      throw new Error(
        'Could not read this invoice\'s amount - amount-less invoices are not supported.'
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
      throw new Error('Amount is outside the payee\'s sendable range.')
    }
    const result = await requestInvoice(info.callback, amountMsat, options)
    invoice = result.pr
    amount = amountMsat
  }

  const carve = await ensureExactAmount(bearers, amount, options)
  const k1 = requireNoteK1(carve.note.url)
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
    if (
      !sameInvoice(proof.pr, invoice) &&
      proofAmount !== null &&
      proofAmount !== amount
    ) {
      return {outcome: 'unknown-still-pending', carve, invoice, amountMsat: amount, verifyUrl}
    }
    return {outcome: 'settled', carve, invoice, amountMsat: amount, verifyUrl}
  } catch {
    // the verify budget ran out - probe the note itself with a rotate: a
    // failed melt is only observable as the note becoming spendable again
    try {
      const rotated = await rotateNote(carve.note.callback, k1, options)
      // the rotate succeeded, so the mint restored the note - and k1 had
      // been on the wire since the melt, so the rotation doubles as the
      // required re-securing of the returned funds
      return {
        outcome: 'failed-funds-returned',
        carve: {
          ...carve,
          note: {
            ...carve.note,
            url: withNewK1(carve.note.url, rotated.k1, amount, rotated.signature)
          }
        },
        invoice,
        amountMsat: amount,
        verifyUrl
      }
    } catch (err) {
      if (err instanceof PendingNoteError) {
        // still locked mid-melt - no outcome either way
        return {outcome: 'unknown-still-pending', carve, invoice, amountMsat: amount, verifyUrl}
      }
      if (err instanceof NoteSpentError) {
        // burned without a settled proof - the money is gone either way
        return {outcome: 'settled', carve, invoice, amountMsat: amount, verifyUrl}
      }
      if (err instanceof AmbiguousMutationError) {
        // the rotate's answer was lost. Had the note still been pending,
        // the service would have said so cleanly - so the funds ARE back,
        // but whether the rotation landed is unknown: the original k1 may
        // be live, or the fresh secret may be the only copy. Surface both.
        const rescuedNote: NewBearer = {
          url: withNewK1(carve.note.url, err.newSecrets[0], amount),
          callback: carve.note.callback,
          amount,
          verified: false
        }
        if (carve.note.mintPubkey) rescuedNote.mintPubkey = carve.note.mintPubkey
        return {
          outcome: 'failed-funds-returned',
          carve,
          invoice,
          amountMsat: amount,
          verifyUrl,
          rescuedNote
        }
      }
      return {outcome: 'unknown-still-pending', carve, invoice, amountMsat: amount, verifyUrl}
    }
  }
}
