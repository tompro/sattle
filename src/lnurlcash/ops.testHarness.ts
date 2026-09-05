import {afterEach, expect} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {sha256} from '@noble/hashes/sha2.js'
import {buildNoteUrl, fetchNoteInfo} from 'lnurlcash-kit'

import type {Bearer} from './types'
import {requiredValue} from './test-utils'

export type Mint = Awaited<ReturnType<typeof createMockMint>>

const mints: Mint[] = []

export const mint = async (options: Parameters<typeof createMockMint>[0] = {}): Promise<Mint> => {
  const instance = await createMockMint(options)
  mints.push(instance)
  return instance
}

afterEach(async () => {
  await Promise.all(mints.splice(0).map((instance) => instance.close()))
})

export const secret = (seed: string): string =>
  bytesToHex(sha256(hexToBytes('00'.repeat(31) + seed)))

export const persistOutput = async (): Promise<void> => undefined

// deterministic stand-in for the wallet's BIP-32 allocation path: answers
// every reservation with fresh unique secrets, never reusing one
let allocatedSecretCounter = 0
export const allocateOutputSecrets = (
  _server: string,
  count: number,
): Promise<readonly string[]> => {
  const secrets = Array.from({length: count}, () => {
    allocatedSecretCounter += 1
    return bytesToHex(sha256(utf8ToBytes(`allocated-${allocatedSecretCounter}`)))
  })
  return Promise.resolve(secrets)
}

// the receive-rotation staging checkpoint - engine tests keep no wallet,
// so staging is a recorded no-op for them
export const stageRotation = async (): Promise<void> => undefined

// the trusted signing keys a production caller would serve from the
// trusted-mint registry: the mock mint's current key plus any it retired
export const signatureKeysFor =
  (instance: Mint) =>
  (): readonly string[] =>
    [instance.state.pubkey, ...instance.state.previousPubkeys]

export const noteUrl = (instance: Mint, k1: string, amountMsat?: number): string =>
  buildNoteUrl(`${instance.url}/w`, k1, amountMsat)

let fixtureCounter = 0
export const makeBearer = async (
  instance: Mint,
  k1: string,
  amountMsat: number,
): Promise<Bearer> => {
  instance.state.creditNote(k1, amountMsat)
  const url = noteUrl(instance, k1, amountMsat)
  const info = await fetchNoteInfo(url)
  fixtureCounter += 1
  return {
    id: `fixture-${fixtureCounter}`,
    url,
    callback: info.callback,
    amount: info.maxWithdrawable,
    verified: true,
    mintPubkey: instance.state.pubkey,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

export const settleLastInvoice = async (instance: Mint): Promise<string> => {
  const paymentHash = requiredValue([...instance.state.invoices.keys()].at(-1))
  const response = await fetch(`${instance.url}/_test/settle?payment_hash=${paymentHash}`)
  if (!response.ok) throw new Error(`settle hook failed: ${response.status}`)
  return requiredValue(instance.state.invoices.get(paymentHash)).preimage
}

export const settleWhenRequested = async (instance: Mint): Promise<string> => {
  for (let attempt = 0; attempt < 200 && instance.state.invoices.size === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return settleLastInvoice(instance)
}

export const expectBurned = async (instance: Mint, k1: string): Promise<void> => {
  for (let attempt = 0; attempt < 200 && instance.state.noteState(k1) !== 'burned'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(instance.state.noteState(k1)).toBe('burned')
}

// a fetch wrapper that answers every /w/cb request with the response to
// its SECOND, byte-identical send - the HTTP-stack GET retry a real client
// is subject to: the mint executes the first attempt and (with the mock's
// default retriedMutation: 'refuse', which is also lnurl-mint's behavior)
// refuses the repeat as an already-spent input, which is all the caller
// ever sees
export const retryingCbFetch = (): typeof fetch => {
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/w/cb')) {
      const first = await fetch(input, init)
      await first.arrayBuffer()
      return fetch(input, init)
    }
    return fetch(input, init)
  }
  return impl
}
