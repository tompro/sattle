import {describe, expect, it} from 'vitest'
import {hashK1, noteK1} from 'lnurlcash-kit'

import {claimMintedNote, prepareMint} from './ops'
import {requiredValue} from './test-utils'
import type {Mint} from './ops.testHarness'
import {mint, settleLastInvoice} from './ops.testHarness'

const HEX32 = /^[0-9a-f]{64}$/

// the invoice whose quote the wallet bound to its own output hash
const boundInvoice = (instance: Mint) =>
  [...instance.state.invoices.values()].find((invoice) => invoice.boundTo)

describe('mint -> claim, named output (comment/mintToHash)', () => {
  it('names the quote with the hash of a wallet-chosen secret', async () => {
    const instance = await mint({commentAllowed: 64, testHooks: true})
    const prepared = await prepareMint(`mint@127.0.0.1:${instance.port}`, 21_000)
    expect(prepared.mode).toBe('named')
    const noteSecret = requiredValue(prepared.noteSecret)
    expect(noteSecret).toMatch(HEX32)
    // the mint bound the quote to sha256 of the wallet's secret - the kit
    // sends it as both comment and h, the mock read one of them
    expect(boundInvoice(instance)?.boundTo).toBe(hashK1(noteSecret))
  })

  it('claims a named output at the wallet secret, without a rotate', async () => {
    const instance = await mint({commentAllowed: 64, testHooks: true})
    const prepared = await prepareMint(`mint@127.0.0.1:${instance.port}`, 21_000)
    const noteSecret = requiredValue(prepared.noteSecret)
    const preimage = await settleLastInvoice(instance)
    const claimed = await claimMintedNote(prepared, {
      intervalMs: 10,
      intervalCapMs: 50,
      maxWaitMs: 5_000,
    })
    expect(claimed.rotated).toBe(true)
    expect(claimed.note.verified).toBe(true)
    expect(claimed.note.amount).toBe(21_000)
    expect(claimed.note.callback).toBe(`${instance.url}/w/cb`)
    expect(noteK1(claimed.note.url)).toBe(noteSecret)
    // no rotate happened: the note still stands at the wallet's own
    // secret, and the payment preimage keys nothing at all
    expect(instance.state.noteState(noteSecret)).toBe('outstanding')
    expect(instance.state.noteState(preimage)).toBeNull()
  })

  it('names the output through the mintToHash spelling too', async () => {
    const instance = await mint({mintToHash: true, testHooks: true})
    const prepared = await prepareMint(`mint@127.0.0.1:${instance.port}`, 21_000)
    expect(prepared.mode).toBe('named')
    expect(boundInvoice(instance)?.boundTo).toBe(hashK1(requiredValue(prepared.noteSecret)))
    const preimage = await settleLastInvoice(instance)
    const claimed = await claimMintedNote(prepared, {
      intervalMs: 10,
      intervalCapMs: 50,
      maxWaitMs: 5_000,
    })
    expect(noteK1(claimed.note.url)).toBe(prepared.noteSecret)
    expect(instance.state.noteState(preimage)).toBeNull()
  })

  it('keeps an unnamed mint on the preimage path', async () => {
    const instance = await mint({testHooks: true})
    const prepared = await prepareMint(`mint@127.0.0.1:${instance.port}`, 21_000)
    expect(prepared.mode).toBe('unnamed')
    expect(prepared.noteSecret).toBeUndefined()
    // the quote was NOT bound - nothing named an output
    expect(boundInvoice(instance)).toBeUndefined()
  })

  it('times out cleanly when a named mint invoice is never paid', async () => {
    const instance = await mint({commentAllowed: 64, testHooks: true})
    const prepared = await prepareMint(`mint@127.0.0.1:${instance.port}`, 21_000)
    await expect(
      claimMintedNote(prepared, {intervalMs: 10, intervalCapMs: 20, maxWaitMs: 100}),
    ).rejects.toThrow(/not confirmed/i)
  })

  it('rescues through the preimage when the mint credited it anyway and serves verify', async () => {
    // the mintToHashIgnoresH adversary: claims the capability, binds
    // nothing, credits the payment hash - the preimage is still the money
    const instance = await mint({
      commentAllowed: 64,
      mintToHashIgnoresH: true,
      verifyOnUnnamedMint: true,
      testHooks: true,
    })
    const prepared = await prepareMint(`mint@127.0.0.1:${instance.port}`, 21_000)
    const preimage = await settleLastInvoice(instance)
    expect(instance.state.noteState(preimage)).toBe('outstanding')
    const claimed = await claimMintedNote(prepared, {
      intervalMs: 10,
      intervalCapMs: 20,
      maxWaitMs: 300,
    })
    expect(claimed.rotated).toBe(true)
    expect(claimed.note.verified).toBe(true)
    // claimed through the preimage path and rotated off it, because that
    // preimage rode the invoice
    expect(instance.state.noteState(preimage)).toBe('burned')
    const k1 = requiredValue(noteK1(claimed.note.url))
    expect(k1).not.toBe(preimage)
    expect(instance.state.noteState(k1)).toBe('outstanding')
  })

  it('fails loudly when the mint credits the preimage and serves no verify', async () => {
    const instance = await mint({commentAllowed: 64, mintToHashIgnoresH: true, testHooks: true})
    const prepared = await prepareMint(`mint@127.0.0.1:${instance.port}`, 21_000)
    // verify is withheld on the unnamed fallback - there the preimage IS
    // the note, so a compliant mint never serves it
    expect(prepared.verifyUrl).toBeNull()
    const preimage = await settleLastInvoice(instance)
    await expect(
      claimMintedNote(prepared, {intervalMs: 10, intervalCapMs: 20, maxWaitMs: 200}),
    ).rejects.toThrow(/not confirmed/i)
    // the money exists at the preimage but is unreachable without verify -
    // the wallet must NOT report a success here
    expect(instance.state.noteState(preimage)).toBe('outstanding')
  })
})
