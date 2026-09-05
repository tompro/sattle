// Transfer between mints: moving value off one mint onto another. The
// protocol has no such primitive - a transfer is composed from the two
// that exist: this wallet requests an invoice FROM the target mint
// (grossed up for its advertised mint fee, so the note that comes out
// nets the requested amount), melts source notes to pay it, then claims
// the target note exactly like any other minted receive. The target note
// appearing at the wallet's pre-staged secret is the transfer's ground
// truth: it can only appear if the source melt's payment arrived.
//
// When settlement never confirms, the source note itself is the oracle -
// a successful rotate proves the melt never burned it (funds returned),
// anything else stays uncertain.

import {
  AmbiguousMutationError,
  NoteSpentError,
  NoteUnknownError,
  PendingNoteError,
  buildNoteUrl,
  defaultRandomSecret,
  fetchNoteInfo,
  meltNote,
  newSecretsOf,
  noteK1,
  requireNoteK1,
  rotateNote,
  serverOf,
  withNewK1,
} from 'lnurlcash-kit'
import type {LnurlcashOptions} from 'lnurlcash-kit'
import type {Bearer, NewBearer} from '../types'
import type {CarveResult} from './carve'
import {ensureExactAmount} from './carve'
import type {ClaimedNote, PreparedMint, PrepareMintOptions} from './mint'
import {MintedNoteSpentError, claimFromSecret, prepareMint} from './mint'
import type {PollOptions} from './shared'
import type {FundOperationOptions} from './shared'
import {assertFundOwner, withMutationSafety} from './shared'

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
  note: NewBearer
  // the wallet-chosen secret the target note lands at.
  // The note exists at this secret from the moment the invoice settles -
  // the caller can rebuild the note URL from it and retry the claim
  noteSecret: string
}

export type TransferResult = {
  outcome: TransferOutcome
  // the source-side changeset: consumed inputs and any change note
  carve: CarveResult
  quote: TransferQuote
  // the invoice the source note was melted to pay
  invoice: string
  // the target invoice's optional verify URL (used for a payment receipt;
  // the staged note itself is the settlement observation)
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
  // persists the target note before its hash reaches the invoice callback
  persistOutput: PrepareMintOptions['persistOutput']
  // Last durable checkpoint before the source melt can become irreversible.
  onMeltReady?: (carve: CarveResult, sourceRecoverySecret: string) => void | Promise<void>
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

const transferSources = (bearers: Bearer[], targetServer: string, grossMsat: number): Bearer[] => {
  const eligible = bearers.filter(
    (bearer) => !bearer.spent && bearer.callback !== '' && !bearer.deviceId && noteK1(bearer.url),
  )
  const candidates = eligible.filter((bearer) => serverOf(bearer.url) !== targetServer)
  if (eligible.length > 0 && candidates.length === 0) {
    throw new Error("That's the mint these notes are already on - pick a different target.")
  }
  const totals = new Map<string, number>()
  for (const bearer of candidates) {
    const server = serverOf(bearer.url)
    totals.set(server, (totals.get(server) ?? 0) + bearer.amount)
  }
  if (![...totals.values()].some((total) => total >= grossMsat)) {
    throw new Error('No mint holds enough verified, unspent balance to cover that amount.')
  }
  return candidates
}

export type PendingTransferSourceRecovery =
  | {readonly state: 'pending'}
  | {readonly state: 'spent'}
  | {readonly state: 'returned'; readonly note: NewBearer}

export const recoverPendingTransferSource = async (
  staged: Bearer,
  source: Bearer,
  options: FundOperationOptions = {},
): Promise<PendingTransferSourceRecovery> => {
  // a recovery only ever PROBES the melt outcome and rotates - it never
  // replays the melt itself; the forced policy pins signature/retry safety
  const mutationOptions = withMutationSafety(options)
  const recoverySecret = staged.pendingMint?.sourceRecoverySecret
  if (!recoverySecret) throw new Error('The pending transfer source recovery secret is missing.')
  const recoveredUrl = withNewK1(source.url, recoverySecret, source.amount)
  assertFundOwner(options)
  try {
    const recovered = await fetchNoteInfo(recoveredUrl, mutationOptions)
    const note: NewBearer = {
      url: withNewK1(source.url, recoverySecret, recovered.maxWithdrawable),
      callback: recovered.callback,
      amount: recovered.maxWithdrawable,
      verified: true,
    }
    if (source.mintPubkey) note.mintPubkey = source.mintPubkey
    return {state: 'returned', note}
  } catch (error) {
    if (error instanceof NoteSpentError) return {state: 'spent'}
    if (!(error instanceof NoteUnknownError)) throw error
  }
  assertFundOwner(options)
  try {
    const rotated = await rotateNote(source.callback, requireNoteK1(source.url), {
      ...mutationOptions,
      randomSecret: () => recoverySecret,
    })
    const note: NewBearer = {
      url: withNewK1(source.url, recoverySecret, source.amount, rotated.signature),
      callback: source.callback,
      amount: source.amount,
      verified: true,
    }
    if (source.mintPubkey) note.mintPubkey = source.mintPubkey
    return {state: 'returned', note}
  } catch (error) {
    if (
      error instanceof PendingNoteError ||
      error instanceof NoteSpentError ||
      error instanceof AmbiguousMutationError ||
      newSecretsOf(error).includes(recoverySecret)
    ) {
      return {state: 'pending'}
    }
    throw error
  }
}

export const transferBetweenMints = async (
  bearers: Bearer[],
  amountMsat: number,
  targetMint: string,
  {poll = {}, kit = {}, assertOwner, onCarve, persistOutput, onMeltReady}: TransferOptions,
): Promise<TransferResult> => {
  const options: FundOperationOptions = withMutationSafety({
    ...kit,
    ...(assertOwner ? {assertOwner} : {}),
    ...(onCarve ? {onCarve} : {}),
  })
  if (!Number.isInteger(amountMsat) || amountMsat <= 0) {
    throw new Error('Amount must be a positive whole number of msat.')
  }
  // resolving the target and requesting its invoice touches only the
  // TARGET mint - a failure here (unreachable, no minting support, amount
  // out of range) leaves every source note untouched
  const prepared = await prepareMint(targetMint, amountMsat, {
    ...options,
    persistOutput,
    beforePersist: ({grossMsat, server}) => {
      transferSources(bearers, server, grossMsat)
    },
  })
  const verifyUrl = prepared.verifyUrl
  const targetServer = prepared.server
  // the source must be a DIFFERENT mint - value "moved" within one mint
  // goes nowhere (melt pays an invoice; the same mint's invoice just
  // re-mints into itself, paying fees for nothing)
  const offTarget = transferSources(bearers, targetServer, prepared.grossMsat)
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
    noteSecret: prepared.noteSecret,
    note: namedClaimNote(prepared, prepared.noteSecret),
  }
  // from here on the carve's fresh secrets exist only in this result - the
  // flow never throws again; every outcome carries them
  const base = {carve, quote, invoice, verifyUrl, sourceServer, targetServer}
  const k1 = requireNoteK1(carve.note.url)
  const sourceRecoverySecret = (kit.randomSecret ?? defaultRandomSecret)()
  if (carve.consumed.length === 0) assertFundOwner(options)
  await onMeltReady?.(carve, sourceRecoverySecret)
  assertFundOwner(options)
  try {
    await meltNote(carve.note.callback, k1, invoice, options)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    if (error instanceof NoteSpentError) {
      return {...base, outcome: 'note-already-spent'}
    }
    // anything else - a clean refusal, a dropped response, a lost answer -
    // is resolved below: the target invoice settles only if this melt's
    // payment arrived, and the source probe tells the rest
  }
  try {
    try {
      const claimed = await claimFromSecret(prepared, poll, options)
      return {...base, outcome: 'settled', mintedAtTarget: claimed}
    } catch (error) {
      if (error instanceof MintedNoteSpentError) {
        return {...base, outcome: 'settled-claim-failed', claimMaterial}
      }
      throw new Error('The target note could not be confirmed at its staged secret.', {
        cause: error,
      })
    }
  } catch {
    // the target invoice never settled within budget - the source note is
    // the oracle now: a successful rotate proves the melt never burned it
    // (and re-secures it, since the melt attempt put k1 on the wire);
    // pending means the melt is still in flight; spent means the payment
    // left but never arrived within the budget - the claim material stays
    // as the way back to the money if the invoice settles later
    try {
      const rotated = await rotateNote(carve.note.callback, k1, {
        ...options,
        randomSecret: () => sourceRecoverySecret,
      })
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
        // The rotate's answer was lost. Keep the transfer journal until
        // recovery proves whether the original or recovery secret is live.
        const rescuedNote: NewBearer = {
          url: withNewK1(carve.note.url, err.newSecrets[0], carve.note.amount),
          callback: carve.note.callback,
          amount: carve.note.amount,
          verified: false,
        }
        if (carve.note.mintPubkey) rescuedNote.mintPubkey = carve.note.mintPubkey
        return {...base, outcome: 'unknown-still-pending', claimMaterial, rescuedNote}
      }
      return {...base, outcome: 'unknown-still-pending', claimMaterial}
    }
  }
}
