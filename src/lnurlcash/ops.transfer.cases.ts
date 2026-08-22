import {describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {noteK1} from 'lnurlcash-kit'

import {transferBetweenMints} from './ops'
import {requiredValue} from './test-utils'
import {expectBurned, makeBearer, mint, secret, settleWhenRequested} from './ops.testHarness'

describe('transferBetweenMints', () => {
  const fastPoll = {intervalMs: 10, intervalCapMs: 50, maxWaitMs: 5_000}

  it('moves value to another mint: melt at source, claim + rotate at target', async () => {
    const source = await mint()
    const target = await mint({testHooks: true})
    const k1 = secret('40')
    const bearer = await makeBearer(source, k1, 21_000)
    const pending = transferBetweenMints([bearer], 21_000, `mint@127.0.0.1:${target.port}`, {
      poll: fastPoll,
    })
    const preimage = await settleWhenRequested(target)
    const result = await pending
    expect(result.outcome).toBe('settled')
    expect(result.invoice).toMatch(/^lnbc/)
    expect(result.quote).toEqual({
      requestedMsat: 21_000,
      grossMsat: 21_000,
      targetMintFeeMsat: 0,
      sourceMeltFeeReserveMsat: 0,
    })
    expect(result.sourceServer).not.toBe(result.targetServer)
    await expectBurned(source, k1)
    const claimed = requiredValue(result.mintedAtTarget)
    expect(claimed.rotated).toBe(true)
    expect(claimed.note.amount).toBe(21_000)
    expect(claimed.note.verified).toBe(true)
    expect(target.state.noteState(preimage)).toBe('burned')
    const newK1 = requiredValue(noteK1(claimed.note.url))
    expect(newK1).not.toBe(preimage)
    expect(target.state.noteState(newK1)).toBe('outstanding')
  })

  it('refuses an amount no source mint can cover', async () => {
    const source = await mint()
    const target = await mint()
    const k1 = secret('41')
    const bearer = await makeBearer(source, k1, 5_000)
    await expect(
      transferBetweenMints([bearer], 50_000, `mint@127.0.0.1:${target.port}`),
    ).rejects.toThrow(/enough/)
    expect(source.state.noteState(k1)).toBe('outstanding')
  })

  it('rejects a transfer onto the mint the notes are already on', async () => {
    const instance = await mint()
    const k1 = secret('42')
    const bearer = await makeBearer(instance, k1, 21_000)
    await expect(
      transferBetweenMints([bearer], 21_000, `mint@127.0.0.1:${instance.port}`),
    ).rejects.toThrow(/different target/)
    expect(instance.state.noteState(k1)).toBe('outstanding')
  })

  it('moves nothing when the target mint is unreachable', async () => {
    const source = await mint()
    const dead = await createMockMint()
    const deadAddress = `mint@127.0.0.1:${dead.port}`
    await dead.close()
    const k1 = secret('43')
    const bearer = await makeBearer(source, k1, 50_000)
    await expect(transferBetweenMints([bearer], 21_000, deadAddress)).rejects.toThrow()
    expect(source.state.noteState(k1)).toBe('outstanding')
  })

  it('recovers from a melt whose answer was lost once the target invoice settles', async () => {
    const source = await mint({unconfirmedMutation: true})
    const target = await mint({testHooks: true})
    const k1 = secret('44')
    const bearer = await makeBearer(source, k1, 21_000)
    const pending = transferBetweenMints([bearer], 21_000, `mint@127.0.0.1:${target.port}`, {
      poll: fastPoll,
    })
    await settleWhenRequested(target)
    const result = await pending
    expect(result.outcome).toBe('settled')
    await expectBurned(source, k1)
    expect(result.mintedAtTarget?.note.amount).toBe(21_000)
    expect(result.mintedAtTarget?.rotated).toBe(true)
  })

  it('surfaces the claimable preimage note when the claim fails after a settled melt', async () => {
    const source = await mint()
    const target = await mint({testHooks: true, echoWrongK1: true})
    const k1 = secret('45')
    const bearer = await makeBearer(source, k1, 21_000)
    const pending = transferBetweenMints([bearer], 21_000, `mint@127.0.0.1:${target.port}`, {
      poll: fastPoll,
    })
    const preimage = await settleWhenRequested(target)
    const result = await pending
    expect(result.outcome).toBe('settled-claim-failed')
    await expectBurned(source, k1)
    const note = requiredValue(result.claimMaterial?.note)
    expect(noteK1(note.url)).toBe(preimage)
    expect(note.verified).toBe(false)
    expect(note.amount).toBe(21_000)
    expect(result.claimMaterial?.withdrawLink).toContain(`${target.port}`)
  })

  it('grosses the carve up for the target mint fee, refusing when only the net is covered', async () => {
    const source = await mint()
    const target = await mint({baseFeeMsat: 1_000, feePpm: 2_000})
    const k1 = secret('46')
    const bearer = await makeBearer(source, k1, 100_000)
    await expect(
      transferBetweenMints([bearer], 100_000, `mint@127.0.0.1:${target.port}`),
    ).rejects.toThrow(/enough/)
    expect(source.state.noteState(k1)).toBe('outstanding')
  })

  it('restores the source note, re-secured, when the melt fails', async () => {
    const source = await mint({meltAlwaysFails: true})
    const target = await mint({testHooks: true})
    const k1 = secret('47')
    const bearer = await makeBearer(source, k1, 21_000)
    const result = await transferBetweenMints([bearer], 21_000, `mint@127.0.0.1:${target.port}`, {
      poll: {intervalMs: 10, intervalCapMs: 20, maxWaitMs: 300},
    })
    expect(result.outcome).toBe('failed-funds-returned')
    expect(result.mintedAtTarget).toBeUndefined()
    expect(source.state.noteState(k1)).toBe('burned')
    const returnedK1 = requiredValue(noteK1(result.carve.note.url))
    expect(returnedK1).not.toBe(k1)
    expect(source.state.noteState(returnedK1)).toBe('outstanding')
    expect(result.carve.note.amount).toBe(21_000)
  })
})
