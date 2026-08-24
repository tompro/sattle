// Mint fee math, reusable wherever an amount crosses a mint boundary
// (transfer Max, receive-Lighting amount hints, move-funds quotes). The
// primitives come from lnurlcash-kit (applyMintFee/grossUpForMintFee);
// this module adds the wallet's whole-sat rounding conventions and a
// short-lived quote cache so forms don't refetch a mint's payRequest on
// every keystroke or page visit.
//
// Fee direction matters and is easy to get wrong:
// - netAfterMintFee: a note minted for `grossMsat` comes out worth the
//   net (the mint withholds base + ppm)
// - grossForMintFee: to LAND `netMsat`, the invoice must be this gross
//   (whole sats, like prepareMint's carve target)
// - maxNetForBalance: the most that can be moved out of a balance after
//   the target's fee - floored to whole sats so the gross never
//   overshoots (applyMintFee is monotonic, so grossUp of the floored net
//   stays within the balance)

import {
  applyMintFee,
  fetchMintAddress,
  fetchPayRequest,
  grossUpForMintFee,
  mintAddressUrl,
  resolveMintInput,
  serverOf,
} from 'lnurlcash-kit'
import type {LnurlcashOptions, MintFee} from 'lnurlcash-kit'
import {ceilMsatToSat, floorMsatToSat} from './units'

export const netAfterMintFee = (grossMsat: number, fee: MintFee): number =>
  applyMintFee(grossMsat, fee)

export const grossForMintFee = (netMsat: number, fee: MintFee): number =>
  ceilMsatToSat(grossUpForMintFee(netMsat, fee))

export const maxNetForBalance = (balanceMsat: number, fee: MintFee | null): number =>
  fee ? floorMsatToSat(applyMintFee(balanceMsat, fee)) : balanceMsat

// Fee quotes are per-mint and change rarely; cache briefly by server.
// nulls are cached too - an unreachable mint shouldn't be retried on
// every render either.
const QUOTE_TTL_MS = 60_000
const QUOTE_TIMEOUT_MS = 5_000

const quoteCache = new Map<string, {at: number; fee: MintFee | null}>()

// tests can reset the cache between cases
export const clearMintFeeQuoteCache = (): void => quoteCache.clear()

// A pre-flight read of a mint's advertised receive fee WITHOUT requesting
// an invoice - the same resolution chain as prepareMint (mint-address
// discovery first, its payLink authoritative), so a quote never disagrees
// with what a real mint/transfer would be charged. null when the mint
// advertises no fee, doesn't speak lnurlcash minting, or can't be
// reached right now.
export const quoteMintFee = async (
  mintInput: string,
  options: LnurlcashOptions = {},
): Promise<MintFee | null> => {
  const url = resolveMintInput(mintInput)
  if (!url) return null
  const server = serverOf(url)
  const cached = quoteCache.get(server)
  if (cached && Date.now() - cached.at < QUOTE_TTL_MS) return cached.fee

  const opts: LnurlcashOptions = {timeoutMs: QUOTE_TIMEOUT_MS, ...options}
  let payUrl = url
  const addressUrl = mintAddressUrl(url)
  if (addressUrl) {
    try {
      payUrl = (await fetchMintAddress(addressUrl, opts)).payLink
    } catch (error) {
      // no mint-address support - the plain payRequest guess still works
      if (!(error instanceof Error)) throw error
    }
  }
  let fee: MintFee | null
  try {
    fee = (await fetchPayRequest(payUrl, opts)).mintFee ?? null
  } catch {
    fee = null
  }
  quoteCache.set(server, {at: Date.now(), fee})
  return fee
}
