import {describe, expect, it} from 'vitest'
import {hashK1, noteK1} from 'lnurlcash-kit'

import {claimMintedNote, prepareMint} from './ops'
import {requiredValue} from './test-utils'
import type {Mint} from './ops.testHarness'
import {mint, persistOutput, settleLastInvoice} from './ops.testHarness'

const HEX32 = /^[0-9a-f]{64}$/

const boundInvoice = (instance: Mint) =>
  [...instance.state.invoices.values()].find((invoice) => invoice.boundTo)

describe('mint -> claim, comment-bound output', () => {
  it('names the quote with the hash of a wallet-chosen secret', async () => {
    const instance = await mint({testHooks: true})
    const prepared = await prepareMint(`mint@127.0.0.1:${instance.port}`, 21_000, {
      persistOutput,
    })
    expect(prepared.noteSecret).toMatch(HEX32)
    expect(boundInvoice(instance)?.boundTo).toBe(hashK1(prepared.noteSecret))
  })

  it('claims the output at the wallet secret without rotating it', async () => {
    const instance = await mint({testHooks: true})
    const prepared = await prepareMint(`mint@127.0.0.1:${instance.port}`, 21_000, {
      persistOutput,
    })
    const preimage = await settleLastInvoice(instance)
    const claimed = await claimMintedNote(prepared, {
      intervalMs: 10,
      intervalCapMs: 50,
      maxWaitMs: 5_000,
    })
    expect(claimed.note.verified).toBe(true)
    expect(claimed.note.amount).toBe(21_000)
    expect(claimed.note.callback).toBe(`${instance.url}/w/cb`)
    expect(noteK1(claimed.note.url)).toBe(prepared.noteSecret)
    expect(instance.state.noteState(prepared.noteSecret)).toBe('outstanding')
    expect(instance.state.noteState(preimage)).toBeNull()
  })

  it('times out cleanly when the invoice is never paid', async () => {
    const instance = await mint({testHooks: true})
    const prepared = await prepareMint(`mint@127.0.0.1:${instance.port}`, 21_000, {
      persistOutput,
    })
    await expect(
      claimMintedNote(prepared, {intervalMs: 10, intervalCapMs: 20, maxWaitMs: 100}),
    ).rejects.toThrow(/not confirmed/i)
  })

  it('uses the required comment even when the optional h extension is advertised', async () => {
    const instance = await mint({mintToHash: true, testHooks: true})
    const prepared = await prepareMint(`mint@127.0.0.1:${instance.port}`, 21_000, {
      persistOutput,
    })
    expect(boundInvoice(instance)?.boundTo).toBe(hashK1(prepared.noteSecret))
    await settleLastInvoice(instance)
    const claimed = await claimMintedNote(prepared, {
      intervalMs: 10,
      intervalCapMs: 50,
      maxWaitMs: 5_000,
    })
    expect(noteK1(claimed.note.url)).toBe(prepared.noteSecret)
    expect(requiredValue(noteK1(claimed.note.url))).toMatch(HEX32)
  })
})
