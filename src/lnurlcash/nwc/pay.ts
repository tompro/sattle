// pay_invoice: melt held notes into the client's bolt11, budget-first.
// The budget check and the spend record run inside the connection's
// request queue (service.ts serializes pay_invoice), so no two pays of
// one connection can interleave them. Spends are recorded for settled
// AND unknown-still-pending outcomes - pessimistic on purpose: the money
// may be in flight; a failed payment records nothing.

import {
  decodeBolt11AmountMsat,
  fetchInvoiceVerification,
  isBolt11Invoice,
  noteK1
} from 'lnurlcash-kit'

import type {Bearer, NewBearer} from '../types'
import type {PayResult} from '../ops'
import {UncertainOutcomeError, payWithBearers} from '../ops'

import {budgetRemainingMsat, recordSpend} from './budget'
import type {NwcChangeset, RequestContext} from './context'
import type {NwcResponse} from './protocol'
import {errResult, okResult} from './protocol'

// maps a PayResult onto the store delta, mirroring PayInvoiceDialog's
// semantics: carve inputs lock spent, change is tracked, returned funds
// are tracked UNMARKED, rescued secrets are tracked unverified. One
// deliberate divergence: in the exact-match + funds-returned case the
// original bearer (old k1, burned server-side by the classification
// rotate) is left for the next refresh to reconcile, exactly as the UI
// leaves it - the money itself sits in the re-secured note, which IS
// tracked.
export const payChangeset = (
  bearers: Bearer[],
  result: PayResult
): NwcChangeset => {
  const add: NewBearer[] = []
  const markSpent: string[] = result.carve.consumed.map(b => b.id)
  if (result.carve.change) add.push(result.carve.change)
  if (result.outcome === 'failed-funds-returned') {
    add.push(result.carve.note)
  } else {
    // settled / still-pending / already-spent: the carved note is gone or
    // locked. When it was one of the wallet's own bearers (an exact-match
    // carve), lock that bearer; a freshly carved note is never added -
    // it was born spent
    const carvedK1 = noteK1(result.carve.note.url)
    const existing = carvedK1
      ? bearers.find(b => noteK1(b.url) === carvedK1)
      : undefined
    if (existing) markSpent.push(existing.id)
  }
  if (result.rescuedNote) add.push(result.rescuedNote)
  return {add, markSpent}
}

export const handlePayInvoice = async (
  ctx: RequestContext,
  params: Record<string, unknown>
): Promise<NwcResponse> => {
  const invoice =
    typeof params.invoice === 'string' ? params.invoice.trim() : ''
  if (!isBolt11Invoice(invoice)) {
    return errResult('pay_invoice', 'OTHER', 'Missing or invalid bolt11 invoice.')
  }
  // the melt must match the invoice's amount exactly, so the amount is
  // read from the invoice itself - never trusted from the request
  const amountMsat = decodeBolt11AmountMsat(invoice)
  if (amountMsat === null || amountMsat <= 0) {
    return errResult(
      'pay_invoice',
      'OTHER',
      'Could not read this invoice\'s amount - amount-less invoices are not supported.'
    )
  }
  if (params.amount !== undefined && params.amount !== amountMsat) {
    return errResult(
      'pay_invoice',
      'OTHER',
      'The request\'s amount does not match the invoice.'
    )
  }
  if (
    amountMsat > budgetRemainingMsat(ctx.connection().record, Date.now())
  ) {
    return errResult(
      'pay_invoice',
      'QUOTA_EXCEEDED',
      'This payment exceeds the connection\'s budget.'
    )
  }
  const bearers = ctx.deps.getBearers()
  let result: PayResult
  try {
    result = await payWithBearers(bearers, invoice, {
      poll: ctx.deps.poll ?? {},
      kit: ctx.deps.kit ?? {}
    })
  } catch (err) {
    if (err instanceof UncertainOutcomeError) {
      // the carve's answer was lost and the probe couldn't tell: the
      // possible outputs carry fresh secrets that may be the only money
      // left - tracked unverified, never dropped
      ctx.deps.applyChangeset(
        {add: err.possibleOutputs, markSpent: []},
        ctx.connection(),
        'pay_invoice'
      )
      return errResult(
        'pay_invoice',
        'INTERNAL',
        'The payment preparation could not be confirmed; possible new notes were stored unverified.'
      )
    }
    const message = err instanceof Error ? err.message : String(err)
    return errResult(
      'pay_invoice',
      /enough/i.test(message) ? 'INSUFFICIENT_BALANCE' : 'INTERNAL',
      message
    )
  }
  const spendRecorded = (): void => {
    ctx.updateRecord(recordSpend(ctx.connection().record, amountMsat, Date.now()))
  }
  switch (result.outcome) {
    case 'settled': {
      spendRecorded()
      ctx.deps.applyChangeset(payChangeset(bearers, result), ctx.connection(), 'pay_invoice')
      // the receipt NIP-47 clients expect: the melt's own payment
      // preimage, re-read from the settle proof. A mint that reveals
      // none yields an empty preimage rather than a fabricated one.
      let preimage = ''
      if (result.verifyUrl) {
        try {
          const proof = await fetchInvoiceVerification(
            result.verifyUrl,
            ctx.deps.kit ?? {}
          )
          preimage = proof.preimage ?? ''
        } catch {
          // the settle proof was already polled inside payWithBearers;
          // a failed re-read must not flip the outcome
        }
      }
      return okResult('pay_invoice', {preimage})
    }
    case 'failed-funds-returned':
      ctx.deps.applyChangeset(payChangeset(bearers, result), ctx.connection(), 'pay_invoice')
      return errResult(
        'pay_invoice',
        'PAYMENT_FAILED',
        'The payment failed; the funds are back in the wallet.'
      )
    case 'note-already-spent':
      ctx.deps.applyChangeset(payChangeset(bearers, result), ctx.connection(), 'pay_invoice')
      return errResult(
        'pay_invoice',
        'PAYMENT_FAILED',
        'The note backing this payment was already spent; nothing was paid.'
      )
    case 'unknown-still-pending':
      spendRecorded()
      ctx.deps.applyChangeset(payChangeset(bearers, result), ctx.connection(), 'pay_invoice')
      return errResult(
        'pay_invoice',
        'OTHER',
        'The payment is still in flight; the note stays locked until it reconciles.'
      )
  }
}
