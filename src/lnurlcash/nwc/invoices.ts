// The invoice registry the two-phase make_invoice / lookup_invoice pair
// shares: make_invoice answers with the invoice immediately while this
// module's settleAndClaim watches settlement in the background, claims
// the minted note (rotating it immediately), and only THEN records the
// settlement the lookup reports.
//
// THE PREIMAGE, in lnurlcash terms: the payment preimage IS the minted
// note's initial secret. NIP-47 clients expect it as the settlement
// receipt, so it is handed out - but only after claimFromPreimage has
// rotated the fresh note, when that secret is burned and worthless. If
// the rotation failed (claimed.rotated === false) the preimage is
// withheld: fund safety over spec comfort.

import {isPreimage, sameInvoice} from 'lnurlcash-kit'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils.js'

import type {NewBearer} from '../types'
import type {PreparedMint} from '../ops'
import {claimFromPreimage} from '../ops/mint'
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
// settles claim the note (rotating it immediately) and hand the fresh
// bearer to the caller. Settlement is recorded LAST - after the rotate and
// bearer commit - so lookup can only reveal durably tracked funds and an
// already-burned secret.
// Throws on any failure; the caller marks the entry failed and reports
// through deps.onError.
export const settleAndClaim = async (ctx: RequestContext, entry: PendingInvoice): Promise<void> => {
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
