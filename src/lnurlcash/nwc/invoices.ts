// The invoice registry the two-phase make_invoice / lookup_invoice pair
// shares. A minted note always lives at the wallet-chosen secret that was
// durably staged before quote creation; the payment preimage is only a
// receipt. Settlement becomes visible only after the staged bearer has
// been replaced with the confirmed note details.

import {isPreimage, sameInvoice} from 'lnurlcash-kit'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils.js'

import type {PreparedMint} from '../ops'
import {MintedNoteSpentError} from '../ops'
import {claimFromSecret} from '../ops/mint'
import {pollVerifyUntilSettled} from '../ops/shared'
import type {PollOptions} from '../ops/shared'

import type {PendingInvoice, RequestContext} from './context'

export const DEFAULT_CLAIM_POLL: Required<Omit<PollOptions, 'signal'>> = {
  intervalMs: 2000,
  intervalCapMs: 10_000,
  maxWaitMs: 15 * 60_000,
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const BOLT11_EXPIRY_TAG = BECH32_CHARSET.indexOf('x')
const BOLT11_DEFAULT_EXPIRY_SECONDS = 3600
const SETTLEMENT_GRACE_SECONDS = 14 * 24 * 60 * 60

// The kit has already validated the invoice before this parser runs. Read
// only BOLT11's timestamp and optional expiry tag; an unfamiliar shape stays
// durable forever rather than risking retirement while it could still settle.
export const invoiceRetireAfter = (invoice: string): number | null => {
  const normalized = invoice.toLowerCase()
  const separator = normalized.lastIndexOf('1')
  if (separator < 1 || normalized.length - separator <= 6) return null
  const words = [...normalized.slice(separator + 1, -6)].map((character) =>
    BECH32_CHARSET.indexOf(character),
  )
  if (words.length < 7 || words.some((word) => word < 0)) return null
  const timestamp = words.slice(0, 7).reduce((value, word) => value * 32 + word, 0)
  if (!Number.isSafeInteger(timestamp)) return null
  let expiry = BOLT11_DEFAULT_EXPIRY_SECONDS
  let offset = 7
  // Conformance invoices omit the 65-byte signature; real BOLT11 invoices
  // include its fixed 104 words after the tagged fields.
  const taggedEnd = words.length >= 7 + 104 ? words.length - 104 : words.length
  while (offset + 3 <= taggedEnd) {
    const tag = words[offset]
    const firstLength = words[offset + 1]
    const secondLength = words[offset + 2]
    if (tag === undefined || firstLength === undefined || secondLength === undefined) return null
    const length = firstLength * 32 + secondLength
    const valueStart = offset + 3
    const valueEnd = valueStart + length
    if (valueEnd > taggedEnd) return null
    if (tag === BOLT11_EXPIRY_TAG) {
      expiry = words.slice(valueStart, valueEnd).reduce((value, word) => value * 32 + word, 0)
      if (!Number.isSafeInteger(expiry)) return null
    }
    offset = valueEnd
  }
  const retireAfter = timestamp + expiry + SETTLEMENT_GRACE_SECONDS
  return Number.isSafeInteger(retireAfter) ? retireAfter : null
}

// LUD-21 verify URLs conventionally end in the payment hash. A service
// that uses another shape gets a stable wallet-local correlation id.
export const resolvePaymentHash = (prepared: PreparedMint): string => {
  const fromVerify = prepared.verifyUrl?.match(/\/([0-9a-f]{64})$/i)?.[1]
  if (fromVerify) return fromVerify.toLowerCase()
  return bytesToHex(sha256(utf8ToBytes(prepared.invoice)))
}

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
  if (entry.state === 'settled' && entry.preimage) result.preimage = entry.preimage
  if (entry.settledAt) result.settled_at = entry.settledAt
  return result
}

export const settleAndClaim = async (ctx: RequestContext, entry: PendingInvoice): Promise<void> => {
  const prepared = entry.prepared
  const claimPoll = ctx.deps.claimPoll ?? DEFAULT_CLAIM_POLL
  let preimage: string | null = null
  if (prepared.verifyUrl) {
    // Observation remains interruptible. Once settlement is observed, the
    // claim and durable update ignore shutdown while stop drains the task.
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
  let claimed
  try {
    claimed = await claimFromSecret(
      prepared,
      prepared.verifyUrl ? claimPoll : {...claimPoll, signal: ctx.stopSignal},
      {
        ...(ctx.deps.kit ?? {}),
        assertOwner: ctx.assertOwner,
      },
    )
  } catch (error) {
    if (!(error instanceof MintedNoteSpentError)) throw error
    await ctx.deps.finalizeSpentMintOutput(entry.stagedOutput, ctx.assertOwner)
    throw error
  }
  await ctx.deps.finalizeMintOutput(entry.stagedOutput, claimed.note, ctx.assertOwner)
  entry.settledAt = ctx.nowSeconds()
  entry.state = 'settled'
  if (preimage) entry.preimage = preimage
}
