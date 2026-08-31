// Transfer between mints: moving value off one mint onto another. The
// protocol has no such primitive - a transfer is composed from the two
// that exist: this wallet requests an invoice FROM the target mint
// (grossed up for its advertised mint fee, so the note that comes out
// nets the requested amount), melts source notes to pay it, then claims
// the target note exactly like any other minted receive. The target
// invoice settling is the transfer's ground truth: it can only settle if
// the source melt's payment arrived. How settling is observed and claimed
// depends on the target's minting mode (see mint.ts):
//
// - UNNAMED target: the verify URL is the observation - its settled
//   response reveals the preimage, which IS the note's secret, and the
//   claim rotates off it immediately.
// - NAMED target: the note itself is the observation - the wallet named
//   the output with its own secret at quote time, so the informational
//   GET reporting 'minted' IS the settlement proof, and the note is
//   already at a secret nobody else has seen. No verify URL is needed
//   (but one is used to rescue the mint that took the hash and credited
//   the preimage anyway).
//
// When settlement never confirms, the source note itself is the oracle -
// a successful rotate proves the melt never burned it (funds returned),
// anything else stays uncertain.

import {
  AmbiguousMutationError,
  NoteSpentError,
  PendingNoteError,
  buildNoteUrl,
  decodeBolt11AmountMsat,
  fetchInvoiceVerification,
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
import type {ClaimedNote, PreparedMint} from './mint'
import {claimFromPreimage, pollMintClaim, prepareMint} from './mint'
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
  // named target only: the wallet-chosen secret the target note lands at.
  // The note exists at this secret from the moment the invoice settles -
  // the caller can rebuild the note URL from it and retry the claim
  noteSecret?: string
}

export type TransferResult = {
  outcome: TransferOutcome
  // the source-side changeset: consumed inputs and any change note
  carve: CarveResult
  quote: TransferQuote
  // the invoice the source note was melted to pay
  invoice: string
  // the target invoice's verify URL - an unnamed target's ground truth
  // (a named target may not serve one at all; the note itself is observed)
  verifyUrl: string | null
  sourceServer: string
  targetServer: string
  // the fresh target note, on 'settled'
  mintedAtTarget?: ClaimedNote
  // on failed-funds-returned, when the source-probe rotate succeeded: the
  // returned funds re-secured at a fresh secret. Kept OUT of `carve`
  // (which always describes the carve as committed by the onCarve
  // checkpoint) so an early-committed carve and a post-wait rotation can
  // both be persisted - the carved note the rotate burned must be marked
  // spent, this note added
  rotatedNote?: NewBearer
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
  // carve checkpoint - committed before the melt and the target
  // settlement wait, so an abort mid-wait never strands the carve (see
  // FundOperationOptions.onCarve)
  onCarve?: FundOperationOptions['onCarve']
}

// the claim retry material for a named target: the note at the wallet's
// own secret, unverified until a claim succeeds
const namedClaimNote = (prepared: PreparedMint, noteSecret: string): NewBearer => {
  const note: NewBearer = {
    url: buildNoteUrl(prepared.withdrawLink, noteSecret, prepared.expectedNoteValueMsat),
    callback: '',
    amount: prepared.expectedNoteValueMsat,
    verified: false,
  }
  if (prepared.mintPubkey) note.mintPubkey = prepared.mintPubkey
  return note
}

export const transferBetweenMints = async (
  bearers: Bearer[],
  amountMsat: number,
  targetMint: string,
  {poll = {}, kit = {}, assertOwner, onCarve}: TransferOptions = {},
): Promise<TransferResult> => {
  const options: FundOperationOptions = {
    ...kit,
    ...(assertOwner ? {assertOwner} : {}),
    ...(onCarve ? {onCarve} : {}),
  }
  if (!Number.isInteger(amountMsat) || amountMsat <= 0) {
    throw new Error('Amount must be a positive whole number of msat.')
  }
  // resolving the target and requesting its invoice touches only the
  // TARGET mint - a failure here (unreachable, no minting support, amount
  // out of range) leaves every source note untouched
  const prepared = await prepareMint(targetMint, amountMsat, options)
  if (prepared.mode === 'unnamed' && !prepared.verifyUrl) {
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
  if (prepared.noteSecret) {
    claimMaterial.noteSecret = prepared.noteSecret
    // a named target's note is claimable from the wallet's secret alone,
    // the moment the invoice settles - track it unverified from the start,
    // so a melt that settles after the budget is never a lost note
    claimMaterial.note = namedClaimNote(prepared, prepared.noteSecret)
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
    if (prepared.mode === 'named') {
      const noteSecret = prepared.noteSecret
      if (!noteSecret) throw new Error('The target mint was prepared without a note secret.')
      // the note appearing at the wallet's own secret IS the settlement
      // proof - the target only credits it once the melt's payment landed
      try {
        const claim = await pollMintClaim(prepared.withdrawLink, noteSecret, poll, options)
        if (
          claim.state !== 'minted' ||
          claim.k1 !== noteSecret ||
          claim.amountMsat === null ||
          !claim.callback
        ) {
          // 'spent' on a fresh wallet-chosen secret, a claim naming a
          // secret other than the one polled (impossible through the kit,
          // which returns the queried secret and rejects mismatched
          // echoes - asserted anyway: building from it would track the
          // wrong note), or an incomplete answer: the target misbehaved -
          // the way back to the note is already in the claim material
          return {...base, outcome: 'settled-claim-failed', claimMaterial}
        }
        const note: NewBearer = {
          url: buildNoteUrl(prepared.withdrawLink, claim.k1, claim.amountMsat),
          callback: claim.callback,
          amount: claim.amountMsat,
          verified: true,
        }
        if (prepared.mintPubkey) note.mintPubkey = prepared.mintPubkey
        // no rotate: the secret never rode an invoice (see mint.ts)
        return {...base, outcome: 'settled', mintedAtTarget: {note, rotated: true}}
      } catch (err) {
        // the note never appeared at the wallet's secret within budget.
        // Rescue through the quote's verify when the target serves one:
        // a mint that took the hash but credited the PREIMAGE (the
        // mintToHashIgnoresH adversary) is claimable through the old path
        if (verifyUrl) {
          try {
            const proof = await fetchInvoiceVerification(verifyUrl, options)
            if (proof.settled && sameInvoice(proof.pr, invoice) && proof.preimage) {
              if (isPreimage(proof.preimage)) {
                try {
                  const claimed = await claimFromPreimage(prepared, proof.preimage, options)
                  return {...base, outcome: 'settled', mintedAtTarget: claimed}
                } catch {
                  const note: NewBearer = {
                    url: buildNoteUrl(
                      prepared.withdrawLink,
                      proof.preimage,
                      prepared.expectedNoteValueMsat,
                    ),
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
              }
            }
          } catch {
            // best-effort rescue - fall through to the source-note oracle
          }
        }
        throw err
      }
    }
    if (!verifyUrl) {
      throw new Error(
        'The target mint did not advertise a verify URL - a transfer there cannot auto-claim.',
      )
    }
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
      // the rotate succeeded: the melt provably never landed, and the
      // funds are back - re-secured, since the melt attempt put k1 on the
      // wire. Reported separately from `carve` (see rotatedNote): the
      // carve may already be committed, and its note is what this rotate
      // burned
      return {
        ...base,
        outcome: 'failed-funds-returned',
        rotatedNote: {
          url: withNewK1(carve.note.url, rotated.k1, carve.note.amount, rotated.signature),
          callback: carve.note.callback,
          amount: carve.note.amount,
          verified: true,
          ...(carve.note.mintPubkey ? {mintPubkey: carve.note.mintPubkey} : {}),
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
