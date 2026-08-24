import {afterEach, expect} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
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
