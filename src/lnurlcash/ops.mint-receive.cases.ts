import {describe, expect, it} from 'vitest'
import {
  NoteSpentError,
  PendingNoteError,
  buildNoteUrl,
  fetchNoteInfo,
  meltNote,
  noteK1,
  rotateNote,
} from 'lnurlcash-kit'

import {claimMintedNote, prepareMint, receiveBearer} from './ops'
import {requiredValue} from './test-utils'
import {makeBearer, mint, noteUrl, secret, settleLastInvoice} from './ops.testHarness'

describe('mint -> claim -> rotate', () => {
  it('mints a note from a paid invoice and rotates it immediately', async () => {
    const instance = await mint({testHooks: true})
    const prepared = await prepareMint(`mint@127.0.0.1:${instance.port}`, 21_000)
    expect(prepared.invoice).toMatch(/^lnbc/)
    expect(prepared.verifyUrl).toBeTruthy()
    expect(prepared.expectedNoteValueMsat).toBe(21_000)
    const preimage = await settleLastInvoice(instance)
    const claimed = await claimMintedNote(prepared, {
      intervalMs: 10,
      intervalCapMs: 50,
      maxWaitMs: 5_000,
    })
    expect(claimed.rotated).toBe(true)
    expect(claimed.note.amount).toBe(21_000)
    expect(claimed.note.verified).toBe(true)
    expect(instance.state.noteState(preimage)).toBe('burned')
    const k1 = requiredValue(noteK1(claimed.note.url))
    expect(k1).not.toBe(preimage)
    expect(instance.state.noteState(k1)).toBe('outstanding')
  })

  it('grosses the invoice up for an advertised mint fee', async () => {
    const instance = await mint({testHooks: true, baseFeeMsat: 1_000, feePpm: 2_000})
    const prepared = await prepareMint(`mint@127.0.0.1:${instance.port}`, 100_000)
    expect(prepared.grossMsat).toBeGreaterThan(100_000)
    const preimage = await settleLastInvoice(instance)
    const info = await fetchNoteInfo(
      buildNoteUrl(prepared.withdrawLink, preimage, prepared.expectedNoteValueMsat),
    )
    expect(info.maxWithdrawable).toBeGreaterThanOrEqual(99_000)
    expect(info.maxWithdrawable).toBeLessThanOrEqual(prepared.grossMsat)
    await expect(
      claimMintedNote(prepared, {intervalMs: 10, intervalCapMs: 20, maxWaitMs: 500}),
    ).rejects.toThrow(/different invoice/)
  })

  it('times out cleanly when the invoice is never paid', async () => {
    const instance = await mint({testHooks: true})
    const prepared = await prepareMint(`mint@127.0.0.1:${instance.port}`, 21_000)
    await expect(
      claimMintedNote(prepared, {intervalMs: 10, intervalCapMs: 20, maxWaitMs: 100}),
    ).rejects.toThrow(/not confirmed/i)
  })
})

describe('receiveBearer', () => {
  it("verifies an incoming note and rotates it, burning the sender's copy", async () => {
    const instance = await mint()
    const senderK1 = secret('20')
    instance.state.creditNote(senderK1, 21_000)
    const received = await receiveBearer(noteUrl(instance, senderK1, 21_000), [])
    expect(received.rotated).toBe(true)
    expect(received.note.amount).toBe(21_000)
    expect(received.note.verified).toBe(true)
    const newK1 = requiredValue(noteK1(received.note.url))
    expect(newK1).not.toBe(senderK1)
    expect(instance.state.noteState(senderK1)).toBe('burned')
    expect(instance.state.noteState(newK1)).toBe('outstanding')
  })

  it('refuses a note the wallet already holds', async () => {
    const instance = await mint()
    const senderK1 = secret('21')
    const existing = await makeBearer(instance, senderK1, 21_000)
    await expect(receiveBearer(noteUrl(instance, senderK1, 21_000), [existing])).rejects.toThrow(
      /already/,
    )
  })

  it('surfaces a spent note as definitively spent', async () => {
    const instance = await mint()
    const k1 = secret('22')
    const bearer = await makeBearer(instance, k1, 21_000)
    const info = await fetchNoteInfo(bearer.url)
    await rotateNote(info.callback, k1)
    await expect(receiveBearer(noteUrl(instance, k1, 21_000), [])).rejects.toBeInstanceOf(
      NoteSpentError,
    )
  })

  it('surfaces a note locked mid-melt as pending, not as unverified', async () => {
    const instance = await mint({meltNeverSettles: true})
    const k1 = secret('23')
    const bearer = await makeBearer(instance, k1, 21_000)
    await meltNote(bearer.callback, k1, 'lnbc21n1pjqrstuvwxyz')
    await expect(receiveBearer(noteUrl(instance, k1, 21_000), [])).rejects.toBeInstanceOf(
      PendingNoteError,
    )
  })
})
