// Minting: receiving over Lightning. Current LUD-25 minting is always
// comment-bound: the wallet chooses the future note secret, durably stages
// an unverified bearer for it, and only then sends sha256(secret) with the
// invoice request. Paying the invoice brings that already-tracked note into
// existence; claiming confirms its authoritative value and callback.

import {
  buildNoteUrl,
  claimMintedNote as fetchMintClaim,
  fetchMintAddress,
  fetchPayRequest,
  grossUpForMintFee,
  hashK1,
  lightningAddressUsername,
  mintAddressUrl,
  requestInvoice,
  noteDeclaredAmount,
  noteK1,
  resolveMintInput,
  serverOf,
} from 'lnurlcash-kit'
import type {MintAddressInfo, MintClaim} from 'lnurlcash-kit'
import type {Bearer, NewBearer} from '../types'
import {ceilMsatToSat} from '../units'
import type {OutputSecretAllocator} from './allocation'
import {requireOutputSecrets} from './allocation'
import type {PollOptions} from './shared'
import type {FundOperationOptions} from './shared'
import {assertFundOwner, pollUntil, withMutationSafety} from './shared'

export type PreparedMint = {
  invoice: string
  verifyUrl: string | null
  // The wallet-chosen secret the minted note lands at. Its unverified note
  // is persisted before the invoice request can put this secret's hash on
  // the wire.
  noteSecret: string
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

export type PrepareMintOptions = FundOperationOptions & {
  readonly persistOutput: (note: NewBearer) => void | Promise<void>
  readonly beforePersist?: (quote: {
    readonly grossMsat: number
    readonly server: string
  }) => void | Promise<void>
  // the caller's durable allocation path for the staged note's secret -
  // required: the wallet's reserved BIP-32 indices are the only source a
  // restart can never reuse or lose
  readonly allocateOutputSecrets?: OutputSecretAllocator
}

// Resolve a mint (Lightning Address, bare domain, bech32 LNURL), discover
// its mint address (best-effort LUD-25 experimental endpoint), read its
// payRequest, gross the requested net amount up for the advertised mint
// fee, and request the invoice. Paying the returned invoice is what brings
// the note into existence - see claimMintedNote.
export const prepareMint = async (
  mintInput: string,
  amountMsat: number,
  options: PrepareMintOptions,
): Promise<PreparedMint> => {
  const {beforePersist, persistOutput, ...rest} = options
  // the forced mutation policy (see shared.ts) covers the invoice request
  const kitOptions = withMutationSafety(rest)
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
      nodeInfo = await fetchMintAddress(addressUrl, kitOptions)
      payUrl = nodeInfo.payLink
    } catch (error) {
      // no mint-address support here - proceed with just the guess
      if (!(error instanceof Error)) throw error
    }
  }
  const info = await fetchPayRequest(payUrl, kitOptions)
  if (!info.withdrawLink) {
    throw new Error('This payRequest does not advertise lnurlcash minting (no withdrawLink).')
  }
  const grossMsat = ceilMsatToSat(
    info.mintFee ? grossUpForMintFee(amountMsat, info.mintFee) : amountMsat,
  )
  if (grossMsat < info.minSendable || grossMsat > info.maxSendable) {
    throw new Error("Amount is outside this mint's sendable range.")
  }
  const server = serverOf(payUrl)
  await beforePersist?.({grossMsat, server})
  const [noteSecret] = await requireOutputSecrets(options.allocateOutputSecrets, server, 1)
  const mintPubkey = nodeInfo ? nodeInfo.mintPubkey : info.mintPubkey
  const staged: NewBearer = {
    url: buildNoteUrl(info.withdrawLink, noteSecret, amountMsat),
    callback: '',
    // The URL retains the claimed amount for recovery, but the wallet's
    // balance stays at zero until the mint confirms the authoritative value.
    amount: 0,
    verified: false,
    pendingMint: mintPubkey ? {mintPubkey} : {},
  }
  assertFundOwner(options)
  await persistOutput(staged)
  assertFundOwner(options)
  const invoice = await requestInvoice(info.callback, grossMsat, {
    ...kitOptions,
    h: hashK1(noteSecret),
  })
  const prepared: PreparedMint = {
    invoice: invoice.pr,
    verifyUrl: invoice.verify ?? null,
    noteSecret,
    expectedNoteValueMsat: amountMsat,
    grossMsat,
    mintUrl: payUrl,
    withdrawLink: info.withdrawLink,
    server,
    username: lightningAddressUsername(payUrl),
    nodeInfo,
  }
  if (mintPubkey) prepared.mintPubkey = mintPubkey
  return prepared
}

export type ClaimedNote = {
  note: NewBearer
  rotated: boolean
  possibleCopy?: NewBearer
  rotationError?: string
}

export class MintedNoteSpentError extends Error {
  override readonly name = 'MintedNoteSpentError'

  constructor() {
    super('The mint reports the freshly minted note as already spent.')
  }
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

export type ClaimTarget = {
  withdrawLink: string
  noteSecret: string
  // the net note value asked for - a claim, cross-checked against the
  // service's authoritative maxWithdrawable
  expectedNoteValueMsat: number
  mintPubkey?: string
}

// The note was credited to the wallet's own secret, which rode to the mint
// only as a hash inside the invoice request. The payment preimage opens
// nothing, so the claim needs no preimage and no rotate follows it.
export const claimFromSecret = async (
  target: ClaimTarget,
  poll: PollOptions = {},
  options: FundOperationOptions = {},
): Promise<ClaimedNote> => {
  assertFundOwner(options)
  const claim = await pollMintClaim(target.withdrawLink, target.noteSecret, poll, options)
  if (claim.state === 'spent') {
    throw new MintedNoteSpentError()
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

// Polls until the minted note is claimable at the wallet's staged secret.
export const claimMintedNote = async (
  prepared: PreparedMint,
  poll: PollOptions = {},
  options: FundOperationOptions = {},
): Promise<ClaimedNote> => claimFromSecret(prepared, poll, options)

// One bounded observation for durable recovery. An unpaid invoice is normal:
// keep the staged output and try again at the next wallet/service activation.
export type StagedMintRecovery =
  | {readonly state: 'unminted'}
  | {readonly state: 'pending'}
  | {readonly state: 'spent'}
  | {readonly state: 'minted'; readonly note: NewBearer}

export const recoverStagedMintOutput = async (
  staged: Bearer,
  options: FundOperationOptions = {},
): Promise<StagedMintRecovery> => {
  const noteSecret = noteK1(staged.url)
  const expectedNoteValueMsat = noteDeclaredAmount(staged.url)
  if (!staged.pendingMint || !noteSecret || expectedNoteValueMsat === null) {
    throw new Error('The pending mint output is malformed.')
  }
  const withdrawLink = new URL(staged.url)
  withdrawLink.searchParams.delete('k1')
  withdrawLink.searchParams.delete('amount')
  withdrawLink.searchParams.delete('sig')
  assertFundOwner(options)
  const claim = await fetchMintClaim(withdrawLink.href, noteSecret, withMutationSafety(options))
  if (claim.state === 'unminted') return {state: 'unminted'}
  if (claim.state === 'pending') return {state: 'pending'}
  if (claim.state === 'spent') return {state: 'spent'}
  if (claim.k1 !== noteSecret || claim.amountMsat === null || !claim.callback) {
    throw new Error('The mint did not return the pending output details.')
  }
  const note: NewBearer = {
    url: buildNoteUrl(withdrawLink.href, noteSecret, claim.amountMsat),
    callback: claim.callback,
    amount: claim.amountMsat,
    verified: true,
  }
  if (staged.pendingMint.mintPubkey) note.mintPubkey = staged.pendingMint.mintPubkey
  return {state: 'minted', note}
}
