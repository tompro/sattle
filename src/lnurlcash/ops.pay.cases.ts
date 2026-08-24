import {describe, expect, it} from 'vitest'
import {noteK1} from 'lnurlcash-kit'

import {payWithBearers} from './ops'
import {requiredValue} from './test-utils'
import {makeBearer, mint, secret} from './ops.testHarness'

describe('payWithBearers', () => {
  it('pays a bolt11 invoice by melting an exact note (settled)', async () => {
    const instance = await mint()
    const bearer = await makeBearer(instance, secret('30'), 21_000)
    const result = await payWithBearers([bearer], 'lnbc210n1pjqrstuvwxyz', {
      poll: {intervalMs: 10, intervalCapMs: 50, maxWaitMs: 5_000},
    })
    expect(result.outcome).toBe('settled')
    expect(instance.state.noteState(secret('30'))).toBe('burned')
  })

  it('pays a Lightning Address by requesting an invoice first', async () => {
    const payer = await mint()
    const payee = await mint()
    const bearer = await makeBearer(payer, secret('31'), 21_000)
    const result = await payWithBearers([bearer], `mint@127.0.0.1:${payee.port}`, {
      amountMsat: 21_000,
      poll: {intervalMs: 10, intervalCapMs: 50, maxWaitMs: 5_000},
    })
    expect(result.outcome).toBe('settled')
    expect(result.invoice).toMatch(/^lnbc/)
    expect(payer.state.noteState(secret('31'))).toBe('burned')
  })

  it('carves the exact amount out of a larger note before melting', async () => {
    const instance = await mint()
    const bearer = await makeBearer(instance, secret('32'), 50_000)
    const result = await payWithBearers([bearer], 'lnbc210n1pjqrstuvwxyz', {
      poll: {intervalMs: 10, intervalCapMs: 50, maxWaitMs: 5_000},
    })
    expect(result.outcome).toBe('settled')
    expect(instance.state.noteState(secret('32'))).toBe('burned')
    expect(result.carve.consumed.map((entry) => entry.id)).toEqual([bearer.id])
    expect(result.carve.change?.amount).toBe(29_000)
    const change = requiredValue(result.carve.change)
    expect(instance.state.noteState(requiredValue(noteK1(change.url)))).toBe('outstanding')
  })

  it('classifies a failed melt as funds-returned once the note is spendable again', async () => {
    const instance = await mint({meltAlwaysFails: true})
    const bearer = await makeBearer(instance, secret('33'), 21_000)
    const result = await payWithBearers([bearer], 'lnbc210n1pjqrstuvwxyz', {
      poll: {intervalMs: 10, intervalCapMs: 20, maxWaitMs: 300},
    })
    expect(result.outcome).toBe('failed-funds-returned')
    expect(instance.state.noteState(secret('33'))).toBe('burned')
    const returnedK1 = requiredValue(noteK1(result.carve.note.url))
    expect(instance.state.noteState(returnedK1)).toBe('outstanding')
    expect(result.carve.note.amount).toBe(21_000)
  })

  it('classifies a never-settling melt as unknown-still-pending', async () => {
    const instance = await mint({meltNeverSettles: true})
    const bearer = await makeBearer(instance, secret('34'), 21_000)
    const result = await payWithBearers([bearer], 'lnbc210n1pjqrstuvwxyz', {
      poll: {intervalMs: 10, intervalCapMs: 20, maxWaitMs: 300},
    })
    expect(result.outcome).toBe('unknown-still-pending')
    expect(instance.state.noteState(secret('34'))).toBe('pending')
  })

  it('rejects an amountless or unreadable invoice instead of guessing', async () => {
    const instance = await mint()
    const bearer = await makeBearer(instance, secret('35'), 21_000)
    await expect(payWithBearers([bearer], 'lnbc1pjqrstuvwxyz')).rejects.toThrow(/amount/)
    await expect(payWithBearers([bearer], 'not-an-invoice')).rejects.toThrow(/not a valid/i)
  })
})
