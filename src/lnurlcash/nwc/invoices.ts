// The invoice registry the two-phase make_invoice / lookup_invoice pair
// shares: make_invoice answers with the invoice immediately while this
// module's settleAndClaim watches settlement in the background, claims
// the minted note, and only THEN records the settlement the lookup
// reports.
//
// THE PREIMAGE, in lnurlcash terms: on an UNNAMED mint the payment
// preimage IS the minted note's initial secret. NIP-47 clients expect it
// as the settlement receipt, so it is handed out - but only after
// claimFromPreimage has rotated the fresh note, when that secret is
// burned and worthless. If the rotation failed (claimed.rotated ===
// false) the preimage is withheld: fund safety over spec comfort. On a
// NAMED mint the note lives at a wallet-chosen secret from the start and
// the preimage opens nothing at all, so it is an ordinary payment receipt
// and always safe to hand out.

import {isPreimage, sameInvoice} from 'lnurlcash-kit'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils.js'

import type {NewBearer} from '../types'
import type {PreparedMint} from '../ops'
import {claimFromPreimage, claimFromSecret} from '../ops/mint'
import {pollVerifyUntilSettled} from '../ops/shared'
import type {PollOptions} from '../ops/shared'

import type {PendingInvoice, RequestContext} from './context'

export const DEFAULT_CLAIM_POLL: Required<Omit<PollOptions, 'signal'>> = {
  intervalMs: 2000,
  intervalCapMs: 10_000,
  maxWaitMs: 15 * 60_000,
}

// LUD-21 verify URLs end in /verify/<payment_hash> (the protocol's verify
// convention) - that suffix is the invoice's real payment hash. A service
// that shapes its verify URL differently gets a wallet-local correlation
// id instead (sha256 of the invoice): still unique and stable for
// make_invoice <-> lookup_invoice correlation, just not the on-chain hash.
export const resolvePaymentHash = (prepared: PreparedMint): string => {
  const fromVerify = prepared.verifyUrl?.match(/\/([0-9a-f]{64})$/i)?.[1]
  if (fromVerify) return fromVerify.toLowerCase()
  return bytesToHex(sha256(utf8ToBytes(prepared.invoice)))
}

// the NIP-47 transaction object make_invoice and lookup_invoice share
export const invoiceResult = (entry: PendingInvoice): Record<string, unknown> => {
  const result: Record<string, unknown> = {
    type: 'incoming',
    state: entry.state,
    invoice: entry.invoice,
    payment_hash: entry.paymentHash,
    amount: entry.amountMsat,
    created_at: entry.createdAt,
    metadata: {},
  }
  if (entry.description) result.description = entry.description
  if (entry.expiresAt) result.expires_at = entry.expiresAt
  if (entry.state === 'settled' && entry.preimage) {
    result.preimage = entry.preimage
  }
  if (entry.settledAt) result.settled_at = entry.settledAt
  return result
}

// the background half of make_invoice: watch the invoice, and once it
// settles claim the note (rotating it immediately on an unnamed mint) and
// hand the fresh bearer to the caller. Settlement is recorded LAST - after
// the claim and bearer commit - so lookup can only reveal durably tracked
// funds and, on an unnamed mint, an already-burned secret.
// Throws on any failure; the caller marks the entry failed and reports
// through deps.onError.
export const settleAndClaim = async (ctx: RequestContext, entry: PendingInvoice): Promise<void> => {
  if (entry.prepared.mode === 'named') return settleAndClaimNamed(ctx, entry)
  if (!entry.prepared.verifyUrl) {
    throw new Error(
      'This mint did not advertise a verify URL - the invoice cannot be auto-claimed.',
    )
  }
  // the observation half is interruptible (the client may never pay, so
  // the poll can legally outlive the service); once settlement is seen,
  // everything below - claim, rotate, bearer commit - is fund-critical and
  // deliberately ignores the stop signal: stop's drain awaits it
  const result = await pollVerifyUntilSettled(
    entry.prepared.verifyUrl,
    {...(ctx.deps.claimPoll ?? DEFAULT_CLAIM_POLL), signal: ctx.stopSignal},
    ctx.deps.kit ?? {},
  )
  // a settled report only means this wallet's invoice was paid if it's
  // for the invoice this wallet actually requested
  if (!sameInvoice(result.pr, entry.prepared.invoice)) {
    throw new Error("The service's verify response is for a different invoice than requested.")
  }
  const preimage = result.preimage
  if (!preimage || !isPreimage(preimage)) {
    throw new Error('The payment settled but the service did not reveal the preimage.')
  }
  // claimFromPreimage IS claimMintedNote's claim half (poll above is the
  // other half) - invoked in two steps here because NWC needs the
  // preimage, which claimMintedNote deliberately discards
  const claimed = await claimFromPreimage(entry.prepared, preimage, {
    ...(ctx.deps.kit ?? {}),
    assertOwner: ctx.assertOwner,
  })
  const add: NewBearer[] = [claimed.note]
  if (claimed.possibleCopy) add.push(claimed.possibleCopy)
  await ctx.deps.applyChangeset(
    {add, markSpent: []},
    ctx.connection(),
    'make_invoice',
    ctx.assertOwner,
  )
  entry.settledAt = ctx.nowSeconds()
  entry.state = 'settled'
  if (claimed.rotated) {
    // see the header: only a rotated note makes the preimage a worthless
    // secret, safe to hand out as the settlement receipt
    entry.preimage = preimage
  }
}

// the named-mint half of settleAndClaim: the note lands at the wallet's
// own secret, so its APPEARANCE there is the settlement observation and no
// rotate follows. When the mint also serves the quote's verify, that
// answer's preimage is kept as the NIP-47 receipt (an ordinary payment
// proof on a named mint); a named mint without verify yields a settled
// lookup with no preimage - correct, just receipt-less.
const settleAndClaimNamed = async (
  ctx: RequestContext,
  entry: PendingInvoice,
): Promise<void> => {
  const noteSecret = entry.prepared.noteSecret
  if (!noteSecret) {
    throw new Error('This mint was prepared in named mode without a note secret.')
  }
  const prepared = entry.prepared
  const claimPoll = ctx.deps.claimPoll ?? DEFAULT_CLAIM_POLL
  let preimage: string | null = null
  if (prepared.verifyUrl) {
    // the interruptible observation half: watch settlement on verify,
    // then claim by secret below (fund-critical, uninterruptible)
    const result = await pollVerifyUntilSettled(
      prepared.verifyUrl,
      {...claimPoll, signal: ctx.stopSignal},
      ctx.deps.kit ?? {},
    )
    if (!sameInvoice(result.pr, prepared.invoice)) {
      throw new Error("The service's verify response is for a different invoice than requested.")
    }
    if (result.preimage && isPreimage(result.preimage)) preimage = result.preimage
  }
  // without a verify URL the claim poll IS the observation half, so it
  // stays interruptible; after a verify-observed settlement the note is
  // already there and this returns on the first check
  const claimed = await claimFromSecret(
    {...prepared, noteSecret},
    prepared.verifyUrl ? claimPoll : {...claimPoll, signal: ctx.stopSignal},
    {
      ...(ctx.deps.kit ?? {}),
      assertOwner: ctx.assertOwner,
    },
  )
  const add: NewBearer[] = [claimed.note]
  if (claimed.possibleCopy) add.push(claimed.possibleCopy)
  await ctx.deps.applyChangeset(
    {add, markSpent: []},
    ctx.connection(),
    'make_invoice',
    ctx.assertOwner,
  )
  entry.settledAt = ctx.nowSeconds()
  entry.state = 'settled'
  // the rotate guard still matters here: the rescue path (a mint that
  // took the hash but credited the PREIMAGE) claims through
  // claimFromPreimage, and if its rotate failed the preimage is still a
  // LIVE note secret - withheld exactly like the unnamed path
  if (preimage && claimed.rotated) entry.preimage = preimage
}
