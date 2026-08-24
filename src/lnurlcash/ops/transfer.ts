// Transfer between mints: moving value off one mint onto another. The
// protocol has no such primitive - a transfer is composed from the two
// that exist: this wallet requests an invoice FROM the target mint
// (grossed up for its advertised mint fee, so the note that comes out
// nets the requested amount), melts source notes to pay it, then claims
// the target note from the revealed preimage exactly like any other
// minted receive. The target invoice settling is the transfer's ground
// truth: it can only settle if the source melt's payment arrived, and its
// verify response is what reveals the preimage to claim with. When it
// never settles, the source note itself is the oracle - a successful
// rotate proves the melt never burned it (funds returned), anything else
// stays uncertain.

import {
  AmbiguousMutationError,
  NoteSpentError,
  PendingNoteError,
  buildNoteUrl,
  decodeBolt11AmountMsat,
  isPreimage,
  meltNote,
  noteK1,
  requireNoteK1,
  rotateNote,
  sameInvoice,
  serverOf,
  withNewK1,
} from 'lnurlcash-kit'
import type {LnurlcashOptions} from 'lnurlcash-kit'
import type {Bearer, NewBearer} from '../types'
import type {CarveResult} from './carve'
import {ensureExactAmount} from './carve'
import type {ClaimedNote} from './mint'
import {claimFromPreimage, prepareMint} from './mint'
import type {PollOptions} from './shared'
import type {FundOperationOptions} from './shared'
import {assertFundOwner, pollVerifyUntilSettled} from './shared'

export type TransferOutcome =
  // the melt settled and the target note was claimed (and rotated)
  | 'settled'
  // the melt provably never happened - the source note is restored,
  // re-secured by the rotate that proved it (k1 had been on the wire)
  | 'failed-funds-returned'
  // neither the target invoice nor the source probe confirmed anything -
  // the source note stays locked spent locally until a refresh reconciles
  | 'unknown-still-pending'
  // the carved source note was already spent before the melt even started
  | 'note-already-spent'
  // the target invoice settled (the money arrived) but the claim could
  // not complete - claimMaterial carries everything needed to retry it
  | 'settled-claim-failed'

export type TransferQuote = {
  // the net value the user wants to land on the target mint
  requestedMsat: number
  // what the source side must cover - the target invoice, grossed up for
  // the target's advertised mint fee and rounded to a whole sat
  grossMsat: number
  // the target mint's receive fee as estimated by the gross-up (the
  // service's own fee math is authoritative - the claimed note's amount
  // is what it actually withheld)
  targetMintFeeMsat: number
  // LUD-25 melt has no fee field - the melted note must equal the invoice
  // exactly, so no source-side reserve is even expressible
  sourceMeltFeeReserveMsat: number
}

// everything a caller needs to retry (or log) the target claim when the
// transfer could not complete it - once the melt has settled this
// material IS the money, so it is never dropped
export type TransferClaimMaterial = {
  invoice: string
  withdrawLink: string
  expectedNoteValueMsat: number
  // the preimage note, unverified, once the preimage is known - the
  // preimage IS the note secret; the caller must track it and retry
  note?: NewBearer
}

export type TransferResult = {
  outcome: TransferOutcome
  // the source-side changeset: consumed inputs and any change note
  carve: CarveResult
  quote: TransferQuote
  // the invoice the source note was melted to pay
  invoice: string
  // the target invoice's verify URL - the transfer's ground truth
  verifyUrl: string
  sourceServer: string
  targetServer: string
  // the fresh target note, on 'settled'
  mintedAtTarget?: ClaimedNote
  // present whenever the claim could still complete later
  claimMaterial?: TransferClaimMaterial
  // a fresh secret rescued from an ambiguous rotate while classifying the
  // melt - the caller must track it unverified (same semantics as pay.ts)
  rescuedNote?: NewBearer
}

export type TransferOptions = {
  // verify-poll budget - tests shrink this
  poll?: PollOptions
  // kit transport overrides (fetch injection, timeouts)
  kit?: LnurlcashOptions
  assertOwner?: () => void
}

export const transferBetweenMints = async (
  bearers: Bearer[],
  amountMsat: number,
  targetMint: string,
  {poll = {}, kit = {}, assertOwner}: TransferOptions = {},
): Promise<TransferResult> => {
  const options: FundOperationOptions = assertOwner ? {...kit, assertOwner} : kit
  if (!Number.isInteger(amountMsat) || amountMsat <= 0) {
    throw new Error('Amount must be a positive whole number of msat.')
  }
  // resolving the target and requesting its invoice touches only the
  // TARGET mint - a failure here (unreachable, no minting support, amount
  // out of range) leaves every source note untouched
  const prepared = await prepareMint(targetMint, amountMsat, options)
  if (!prepared.verifyUrl) {
    throw new Error(
      'The target mint did not advertise a verify URL - a transfer there cannot auto-claim.',
    )
  }
  const verifyUrl = prepared.verifyUrl
  const targetServer = prepared.server
  // the source must be a DIFFERENT mint - value "moved" within one mint
  // goes nowhere (melt pays an invoice; the same mint's invoice just
  // re-mints into itself, paying fees for nothing)
  const eligible = bearers.filter(
    (b) => !b.spent && b.callback !== '' && !b.deviceId && noteK1(b.url),
  )
  const offTarget = eligible.filter((b) => serverOf(b.url) !== targetServer)
  if (eligible.length > 0 && offTarget.length === 0) {
    throw new Error("That's the mint these notes are already on - pick a different target.")
  }
  const quote: TransferQuote = {
    requestedMsat: amountMsat,
    grossMsat: prepared.grossMsat,
    targetMintFeeMsat: prepared.grossMsat - amountMsat,
    sourceMeltFeeReserveMsat: 0,
  }
  // carving burns its inputs server-side, so it happens only once the
  // target is known good and the invoice exists
  const carve = await ensureExactAmount(offTarget, prepared.grossMsat, options)
  const sourceServer = serverOf(carve.note.url)
  const invoice = prepared.invoice
  const claimMaterial: TransferClaimMaterial = {
    invoice,
    withdrawLink: prepared.withdrawLink,
    expectedNoteValueMsat: prepared.expectedNoteValueMsat,
  }
  // from here on the carve's fresh secrets exist only in this result - the
  // flow never throws again; every outcome carries them
  const base = {carve, quote, invoice, verifyUrl, sourceServer, targetServer}
  const k1 = requireNoteK1(carve.note.url)
  if (carve.consumed.length === 0) assertFundOwner(options)
  try {
    await meltNote(carve.note.callback, k1, invoice, options)
  } catch (err) {
    if (err instanceof NoteSpentError) {
      // this melt names a single note, so this is unambiguous - it was
      // already gone before the melt even started
      return {...base, outcome: 'note-already-spent'}
    }
    // anything else - a clean refusal, a dropped response, a lost answer -
    // is resolved below: the target invoice settles only if this melt's
    // payment arrived, and the source probe tells the rest
  }
  try {
    const proof = await pollVerifyUntilSettled(verifyUrl, poll, options)
    // the proof-binding rule from pay.ts, extended for the gross-up: the
    // verify URL is scoped to this invoice's payment hash, so an exact pr
    // match binds it; short of that, a proof amount that is neither the
    // invoiced gross nor the expected net belongs to another payment,
    // while an undecodable one says nothing either way and is tolerated
    const proofAmount = decodeBolt11AmountMsat(proof.pr)
    if (
      !sameInvoice(proof.pr, invoice) &&
      proofAmount !== null &&
      proofAmount !== prepared.grossMsat &&
      proofAmount !== prepared.expectedNoteValueMsat
    ) {
      return {...base, outcome: 'unknown-still-pending', claimMaterial}
    }
    if (!proof.preimage || !isPreimage(proof.preimage)) {
      // settled, but the service won't reveal the preimage - the claim
      // cannot complete automatically
      return {...base, outcome: 'settled-claim-failed', claimMaterial}
    }
    try {
      const claimed = await claimFromPreimage(prepared, proof.preimage, options)
      return {...base, outcome: 'settled', mintedAtTarget: claimed}
    } catch {
      // the melt settled - the money is now the preimage note at the
      // target and nowhere else; surface it rather than lose it
      const note: NewBearer = {
        url: buildNoteUrl(prepared.withdrawLink, proof.preimage, prepared.expectedNoteValueMsat),
        callback: '',
        amount: prepared.expectedNoteValueMsat,
        verified: false,
      }
      if (prepared.mintPubkey) note.mintPubkey = prepared.mintPubkey
      return {
        ...base,
        outcome: 'settled-claim-failed',
        claimMaterial: {...claimMaterial, note},
      }
    }
  } catch {
    // the target invoice never settled within budget - the source note is
    // the oracle now: a successful rotate proves the melt never burned it
    // (and re-secures it, since the melt attempt put k1 on the wire);
    // pending means the melt is still in flight; spent means the payment
    // left but never arrived within the budget - the claim material stays
    // as the way back to the money if the invoice settles later
    try {
      const rotated = await rotateNote(carve.note.callback, k1, options)
      return {
        ...base,
        outcome: 'failed-funds-returned',
        carve: {
          ...carve,
          note: {
            ...carve.note,
            url: withNewK1(carve.note.url, rotated.k1, carve.note.amount, rotated.signature),
          },
        },
      }
    } catch (err) {
      if (err instanceof PendingNoteError || err instanceof NoteSpentError) {
        return {...base, outcome: 'unknown-still-pending', claimMaterial}
      }
      if (err instanceof AmbiguousMutationError) {
        // the rotate's answer was lost - pay.ts's reasoning: had the note
        // still been pending the service would have said so, so the funds
        // ARE back, but whether the rotation landed is unknown. Surface
        // the possible fresh copy alongside the unchanged note.
        const rescuedNote: NewBearer = {
          url: withNewK1(carve.note.url, err.newSecrets[0], carve.note.amount),
          callback: carve.note.callback,
          amount: carve.note.amount,
          verified: false,
        }
        if (carve.note.mintPubkey) rescuedNote.mintPubkey = carve.note.mintPubkey
        return {...base, outcome: 'failed-funds-returned', rescuedNote}
      }
      return {...base, outcome: 'unknown-still-pending', claimMaterial}
    }
  }
}
