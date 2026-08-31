// Minting: receiving over Lightning. prepareMint resolves a mint and
// requests the invoice; paying it brings the note into existence;
// claimMintedNote watches the payment and converts it into a wallet-owned
// bearer note.
//
// Two mint generations exist on the wire, and this module speaks both:
//
// - UNNAMED (old): the minted note's k1 IS the payment preimage. The
//   claim takes the preimage from the LUD-21 verify answer and rotates
//   immediately - every routing node and anyone who saw the invoice knew
//   that secret.
// - NAMED (LUD-25 comment/mintToHash, lnurl-mint >= 0.4 requires it): the
//   wallet names the note at quote time with comment = sha256(secret) of
//   a secret it chose, and the note lands at THAT secret. The preimage
//   opens nothing, so no observer race exists and no rotate follows the
//   claim; the claim poll itself is the placement proof (see
//   claimFromSecret).
//
// The mode is decided per mint from the payRequest's capability
// advertisement (commentAllowed >= 64 or mintToHash), never assumed.

import {
  AmbiguousMutationError,
  buildNoteUrl,
  claimMintedNote as fetchMintClaim,
  defaultRandomSecret,
  fetchInvoiceVerification,
  fetchMintAddress,
  fetchNoteInfo,
  fetchPayRequest,
  grossUpForMintFee,
  hashK1,
  isPreimage,
  lightningAddressUsername,
  mintAddressUrl,
  namesMintOutput,
  probeBurnedNote,
  requestInvoice,
  resolveMintInput,
  rotateNote,
  sameInvoice,
  serverOf,
  withNewK1,
} from 'lnurlcash-kit'
import type {MintAddressInfo, MintClaim} from 'lnurlcash-kit'
import type {NewBearer} from '../types'
import {ceilMsatToSat} from '../units'
import type {PollOptions} from './shared'
import type {FundOperationOptions} from './shared'
import {PollAbortedError, assertFundOwner, pollUntil, pollVerifyUntilSettled} from './shared'

export type PreparedMint = {
  invoice: string
  verifyUrl: string | null
  // how this mint keys the note the invoice pays for: 'named' mints credit
  // a wallet-chosen secret (LUD-25 comment/mintToHash), 'unnamed' mints
  // credit the payment preimage
  mode: 'named' | 'unnamed'
  // named mode only: the wallet-chosen secret the minted note lands at.
  // Drawn before the invoice is requested (its hash binds the quote) and
  // carried in memory only - never persisted, never logged. Losing it
  // after payment loses the note, but nothing here was ever recoverable
  // after a crash: the invoice and verify URL die in the same memory
  noteSecret?: string
  // the net note value asked for - the claim cross-checks the service's
  // authoritative maxWithdrawable against it
  expectedNoteValueMsat: number
  // the gross amount actually invoiced (net + mint fee, rounded up to a
  // whole sat - sub-sat invoices aren't reliably payable)
  grossMsat: number
  mintUrl: string
  withdrawLink: string
  mintPubkey?: string
  server: string
  username: string | null
  nodeInfo: MintAddressInfo | null
}

// Resolve a mint (Lightning Address, bare domain, bech32 LNURL), discover
// its mint address (best-effort LUD-25 experimental endpoint), read its
// payRequest, gross the requested net amount up for the advertised mint
// fee, and request the invoice. Paying the returned invoice is what brings
// the note into existence - see claimMintedNote.
export const prepareMint = async (
  mintInput: string,
  amountMsat: number,
  options: FundOperationOptions = {},
): Promise<PreparedMint> => {
  if (!Number.isInteger(amountMsat) || amountMsat <= 0) {
    throw new Error('Amount must be a positive whole number of msat.')
  }
  const url = resolveMintInput(mintInput)
  if (!url) throw new Error('Enter a mint LNURL or Lightning Address.')
  // best-effort mint-address discovery - derived from `url`'s own
  // .well-known/lnurlp/{name} path; when it succeeds, its payLink is the
  // authoritative place to fetch the payRequest from
  const addressUrl = mintAddressUrl(url)
  let nodeInfo: MintAddressInfo | null = null
  let payUrl = url
  if (addressUrl) {
    try {
      nodeInfo = await fetchMintAddress(addressUrl, options)
      payUrl = nodeInfo.payLink
    } catch (error) {
      // no mint-address support here - proceed with just the guess
      if (!(error instanceof Error)) throw error
    }
  }
  const info = await fetchPayRequest(payUrl, options)
  if (!info.withdrawLink) {
    throw new Error('This payRequest does not advertise lnurlcash minting (no withdrawLink).')
  }
  const grossMsat = ceilMsatToSat(
    info.mintFee ? grossUpForMintFee(amountMsat, info.mintFee) : amountMsat,
  )
  if (grossMsat < info.minSendable || grossMsat > info.maxSendable) {
    throw new Error("Amount is outside this mint's sendable range.")
  }
  // a mint that names its outputs takes comment = sha256(secret) with the
  // quote; one that doesn't gets the byte-identical request this wallet
  // always sent, and its note stays keyed by the payment preimage
  const named = namesMintOutput(info)
  let noteSecret: string | undefined
  let h: string | undefined
  if (named) {
    noteSecret = defaultRandomSecret()
    h = hashK1(noteSecret)
  }
  const invoice = await requestInvoice(
    info.callback,
    grossMsat,
    h ? {...options, h} : options,
  )
  const prepared: PreparedMint = {
    invoice: invoice.pr,
    verifyUrl: invoice.verify ?? null,
    mode: named ? 'named' : 'unnamed',
    expectedNoteValueMsat: amountMsat,
    grossMsat,
    mintUrl: payUrl,
    withdrawLink: info.withdrawLink,
    server: serverOf(payUrl),
    username: lightningAddressUsername(payUrl),
    nodeInfo,
  }
  if (noteSecret) prepared.noteSecret = noteSecret
  if (info.mintPubkey) prepared.mintPubkey = info.mintPubkey
  return prepared
}

export type ClaimedNote = {
  note: NewBearer
  // false when the note may be exposed to someone besides this wallet and
  // the mint: an unnamed mint's fresh note whose rotate failed (its k1 was
  // the payment preimage, transmitted and mint-known). A named mint's
  // note always reports true - its secret never rode an invoice, so there
  // is nothing to rotate away from
  rotated: boolean
  // set when the rotate's answer was lost and the probe couldn't tell: the
  // possible rotated copy, to track unverified alongside `note`
  possibleCopy?: NewBearer
  rotationError?: string
}

// Polls a named mint output's informational GET until the note is there:
// 'minted' resolves the wait ('spent' resolves it too - surfaced for the
// caller to reject, never retried); 'unminted' and 'pending' keep it
// going. The poll IS the placement proof for a named output: the service
// only answers 'minted' for the secret it actually credited.
export const pollMintClaim = async (
  withdrawLink: string,
  noteSecret: string,
  poll: PollOptions = {},
  options: FundOperationOptions = {},
): Promise<MintClaim> =>
  pollUntil(
    async (fetchOptions) => {
      const claim = await fetchMintClaim(withdrawLink, noteSecret, fetchOptions)
      return claim.state === 'minted' || claim.state === 'spent' ? claim : null
    },
    'Minted note not confirmed',
    poll,
    options,
  )

// what a claim needs once the preimage is known - PreparedMint satisfies
// this, and so does the target side of an inter-mint transfer (see
// transfer.ts)
export type ClaimTarget = {
  withdrawLink: string
  // the net note value asked for - a claim, cross-checked against the
  // service's authoritative maxWithdrawable
  expectedNoteValueMsat: number
  mintPubkey?: string
}

// what a NAMED-mode claim needs: the wallet's own secret, plus the quote's
// verify URL and invoice as rescue anchors for a mint that took the hash
// but credited the preimage anyway. PreparedMint satisfies this.
export type NamedClaimTarget = ClaimTarget & {
  noteSecret: string
  verifyUrl?: string | null
  invoice?: string
}

// The named-mode claim: the note was credited to the wallet's own secret,
// which rode to the mint as a HASH inside the invoice request - the
// payment preimage opens nothing, so the claim needs no preimage and no
// rotate follows it. The rescue covers the mint that claimed the
// capability but credited the preimage (the kit's mintToHashIgnoresH
// adversary: the wallet was told no rotate is needed while the preimage
// is still the money): when that mint still serves the quote's verify, one
// check recovers the preimage and the note is claimed through the old
// path, WITH the rotate that path exists for. When it serves none there
// is nothing to rescue with - the error stays loud.
export const claimFromSecret = async (
  target: NamedClaimTarget,
  poll: PollOptions = {},
  options: FundOperationOptions = {},
): Promise<ClaimedNote> => {
  assertFundOwner(options)
  let claim: MintClaim
  try {
    claim = await pollMintClaim(target.withdrawLink, target.noteSecret, poll, options)
  } catch (err) {
    if (!(err instanceof PollAbortedError) && target.verifyUrl && target.invoice) {
      try {
        const result = await fetchInvoiceVerification(target.verifyUrl, options)
        if (
          result.settled &&
          sameInvoice(result.pr, target.invoice) &&
          result.preimage &&
          isPreimage(result.preimage)
        ) {
          return claimFromPreimage(target, result.preimage, options)
        }
      } catch {
        // the rescue is best-effort - the original error stands
      }
    }
    throw err
  }
  if (claim.state === 'spent') {
    // a fresh wallet-chosen secret cannot already be spent - the service
    // is lying about the note it just credited
    throw new Error('The mint reports the freshly minted note as already spent.')
  }
  if (claim.k1 !== target.noteSecret) {
    // belt and suspenders: the kit's claimMintedNote returns the queried
    // secret by construction and fetchNoteInfo rejects a mismatched echo,
    // so this cannot trip through the kit - if it ever does, building a
    // note from the answer would track the wrong secret
    throw new Error('The mint answered the claim for a different note secret.')
  }
  if (claim.amountMsat === null || !claim.callback) {
    throw new Error('The mint did not return the minted note details.')
  }
  const note: NewBearer = {
    url: buildNoteUrl(target.withdrawLink, claim.k1, claim.amountMsat),
    callback: claim.callback,
    amount: claim.amountMsat,
    verified: true,
  }
  if (target.mintPubkey) note.mintPubkey = target.mintPubkey
  return {note, rotated: true}
}

// Polls until the minted note is claimable, then claims it. Unnamed mints:
// watch the LUD-21 verify URL for settlement, take the preimage (which IS
// the note secret there), and claim through claimFromPreimage with its
// mandatory rotate. Named mints: watch the note itself appear at the
// wallet's own secret (see claimFromSecret).
export const claimMintedNote = async (
  prepared: PreparedMint,
  poll: PollOptions = {},
  options: FundOperationOptions = {},
): Promise<ClaimedNote> => {
  if (prepared.mode === 'named') {
    const noteSecret = prepared.noteSecret
    if (!noteSecret) {
      throw new Error('This mint was prepared in named mode without a note secret.')
    }
    return claimFromSecret({...prepared, noteSecret}, poll, options)
  }
  if (!prepared.verifyUrl) {
    throw new Error(
      'This mint did not advertise a verify URL - the invoice cannot be auto-claimed.',
    )
  }
  const verifyUrl = prepared.verifyUrl
  const result = await pollVerifyUntilSettled(verifyUrl, poll, options)
  // a settled report only means this wallet's invoice was paid if it's for
  // the invoice this wallet actually requested
  if (!sameInvoice(result.pr, prepared.invoice)) {
    throw new Error("The service's verify response is for a different invoice than requested.")
  }
  const preimage = result.preimage
  if (!preimage || !isPreimage(preimage)) {
    throw new Error('The payment settled but the service did not reveal the preimage.')
  }
  return claimFromPreimage(prepared, preimage, options)
}

// The claim itself, once the payment's preimage is known: the preimage IS
// the note secret. The claim (an informational GET) puts that secret on
// the wire, and the mint has known it since it generated the invoice - so
// the fresh note is rotated immediately and unconditionally (observer
// race: anyone who saw the unpaid invoice knows the payment hash), before
// anything else happens with it.
export const claimFromPreimage = async (
  claim: ClaimTarget,
  preimage: string,
  options: FundOperationOptions = {},
): Promise<ClaimedNote> => {
  // declare the invoiced amount (a claim - not yet confirmed) so the note
  // is self-describing even before the verifying GET below
  const declaredUrl = buildNoteUrl(claim.withdrawLink, preimage, claim.expectedNoteValueMsat)
  assertFundOwner(options)
  // the service's maxWithdrawable is authoritative - SERVICE's own fee
  // math might not match this wallet's estimate, and the note is worth
  // exactly maxWithdrawable regardless
  const noteInfo = await fetchNoteInfo(declaredUrl, options)
  const mintPubkey = noteInfo.mintPubkey ?? claim.mintPubkey
  const base: NewBearer = {
    url: withNewK1(declaredUrl, noteInfo.k1, noteInfo.maxWithdrawable),
    callback: noteInfo.callback,
    amount: noteInfo.maxWithdrawable,
    verified: true,
  }
  if (mintPubkey) base.mintPubkey = mintPubkey

  let url = base.url
  let rotated = true
  let possibleCopy: NewBearer | undefined
  let rotationError: string | undefined
  try {
    const rotatedNote = await rotateNote(noteInfo.callback, noteInfo.k1, options)
    url = withNewK1(declaredUrl, rotatedNote.k1, noteInfo.maxWithdrawable, rotatedNote.signature)
  } catch (err) {
    rotated = false
    if (err instanceof AmbiguousMutationError) {
      // the rotate request may have landed despite the failure - the fresh
      // secret it carried is then the only copy of this note
      const outcome = await probeBurnedNote(declaredUrl, options)
      if (outcome === 'gone') {
        // the burn landed - adopt the fresh secret as the note
        url = withNewK1(declaredUrl, err.newSecrets[0], noteInfo.maxWithdrawable)
        rotated = true
      } else if (outcome === 'unknown') {
        // can't tell: the preimage note is returned either way - the
        // possible rotated copy goes alongside it, both refreshable
        possibleCopy = {
          url: withNewK1(declaredUrl, err.newSecrets[0], noteInfo.maxWithdrawable),
          callback: noteInfo.callback,
          amount: noteInfo.maxWithdrawable,
          verified: false,
        }
        if (mintPubkey) possibleCopy.mintPubkey = mintPubkey
        rotationError = `${err.message} The rotation may still have gone through - the possible rotated copy is tracked unverified alongside this one.`
      } else {
        rotationError = err.message
      }
    } else {
      rotationError = err instanceof Error ? err.message : String(err)
    }
  }
  const claimed: ClaimedNote = {note: {...base, url}, rotated}
  if (possibleCopy) claimed.possibleCopy = possibleCopy
  if (rotationError) claimed.rotationError = rotationError
  return claimed
}
