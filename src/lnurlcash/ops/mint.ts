// Minting: receiving over Lightning. prepareMint resolves a mint and
// requests the invoice; paying it brings the note into existence;
// claimMintedNote watches the payment and converts the revealed preimage
// into a rotated, wallet-owned bearer note.

import {
  AmbiguousMutationError,
  buildNoteUrl,
  fetchMintAddress,
  fetchNoteInfo,
  fetchPayRequest,
  grossUpForMintFee,
  isPreimage,
  lightningAddressUsername,
  mintAddressUrl,
  probeBurnedNote,
  requestInvoice,
  resolveMintInput,
  rotateNote,
  sameInvoice,
  serverOf,
  withNewK1,
} from 'lnurlcash-kit'
import type {MintAddressInfo} from 'lnurlcash-kit'
import type {NewBearer} from '../types'
import {ceilMsatToSat} from '../units'
import type {PollOptions} from './shared'
import type {FundOperationOptions} from './shared'
import {assertFundOwner, pollVerifyUntilSettled} from './shared'

export type PreparedMint = {
  invoice: string
  verifyUrl: string | null
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
  const invoice = await requestInvoice(info.callback, grossMsat, options)
  const prepared: PreparedMint = {
    invoice: invoice.pr,
    verifyUrl: invoice.verify ?? null,
    expectedNoteValueMsat: amountMsat,
    grossMsat,
    mintUrl: payUrl,
    withdrawLink: info.withdrawLink,
    server: serverOf(payUrl),
    username: lightningAddressUsername(payUrl),
    nodeInfo,
  }
  if (info.mintPubkey) prepared.mintPubkey = info.mintPubkey
  return prepared
}

export type ClaimedNote = {
  note: NewBearer
  // false when the rotate after claim failed - the note is tracked either
  // way (it IS money), but the preimage was transmitted and the mint
  // necessarily knows it, so an unrotated note must be treated as exposed
  rotated: boolean
  // set when the rotate's answer was lost and the probe couldn't tell: the
  // possible rotated copy, to track unverified alongside `note`
  possibleCopy?: NewBearer
  rotationError?: string
}

// Polls the mint invoice's LUD-21 verify URL until the payment settles,
// then claims the note: the payment preimage IS the note secret. The claim
// itself (an informational GET) puts that secret on the wire, and the mint
// has known it since it generated the invoice - so the fresh note is
// rotated immediately and unconditionally (observer race: anyone who saw
// the unpaid invoice knows the payment hash), before anything else happens
// with it.
export const claimMintedNote = async (
  prepared: PreparedMint,
  poll: PollOptions = {},
  options: FundOperationOptions = {},
): Promise<ClaimedNote> => {
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
