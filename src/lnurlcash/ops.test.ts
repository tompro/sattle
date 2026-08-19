// The operations engine against the conformance mock mint - a real HTTP
// server that can be told to misbehave. The happy paths matter, but the
// adversarial modes (dropped mutations, failed melts) are what prove the
// fund-safety invariants: fresh secrets are never lost, and melt outcomes
// are classified by proof, not by hope.

import {afterEach, describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {sha256} from '@noble/hashes/sha2.js'
import {
  NoteSpentError,
  PendingNoteError,
  buildNoteUrl,
  fetchNoteInfo,
  meltNote,
  noteK1,
  rotateNote
} from 'lnurlcash-kit'

import type {Bearer} from './types'
import {
  UncertainOutcomeError,
  claimMintedNote,
  ensureExactAmount,
  payWithBearers,
  prepareMint,
  receiveBearer,
  transferBetweenMints
} from './ops'

type Mint = Awaited<ReturnType<typeof createMockMint>>

const mints: Mint[] = []
const mint = async (options: Parameters<typeof createMockMint>[0] = {}): Promise<Mint> => {
  const m = await createMockMint(options)
  mints.push(m)
  return m
}

afterEach(async () => {
  await Promise.all(mints.splice(0).map(m => m.close()))
})

const secret = (seed: string) =>
  bytesToHex(sha256(hexToBytes('00'.repeat(31) + seed)))
const noteUrl = (m: Mint, k1: string, amountMsat?: number) =>
  buildNoteUrl(`${m.url}/w`, k1, amountMsat)

// a verified, ready-to-spend bearer fixture: funded on the mock mint and
// read back through the informational GET, exactly as a real receive would
// learn its callback and authoritative amount
let fixtureCounter = 0
const makeBearer = async (
  m: Mint,
  k1: string,
  amountMsat: number
): Promise<Bearer> => {
  m.state.creditNote(k1, amountMsat)
  const url = noteUrl(m, k1, amountMsat)
  const info = await fetchNoteInfo(url)
  fixtureCounter += 1
  return {
    id: `fixture-${fixtureCounter}`,
    url,
    callback: info.callback,
    amount: info.maxWithdrawable,
    verified: true,
    mintPubkey: m.state.pubkey,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

// paying a mint invoice is what brings its note into existence - the mock
// exposes that through its test hook (settle + credit in one step).
// Returns the paid invoice's preimage, which IS the fresh note's secret.
const settleLastInvoice = async (m: Mint): Promise<string> => {
  const paymentHash = [...m.state.invoices.keys()].at(-1)!
  const res = await fetch(`${m.url}/_test/settle?payment_hash=${paymentHash}`)
  if (!res.ok) throw new Error(`settle hook failed: ${res.status}`)
  return m.state.invoices.get(paymentHash)!.preimage
}

// waits for a mint to have an invoice at all, then settles it - for flows
// that request the invoice deep inside a single awaited call (transfer),
// where the test has to play the arriving payment mid-flight
const settleWhenRequested = async (m: Mint): Promise<string> => {
  for (let i = 0; i < 200 && m.state.invoices.size === 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return settleLastInvoice(m)
}

// the mock burns a melted note 20ms after the melt - a transfer can
// resolve off the TARGET's settlement faster than that, so source-burn
// assertions wait for the mock's own timer instead of racing it
const expectBurned = async (m: Mint, k1: string): Promise<void> => {
  for (let i = 0; i < 200 && m.state.noteState(k1) !== 'burned'; i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(m.state.noteState(k1)).toBe('burned')
}

describe('ensureExactAmount', () => {
  it('returns an already-exact note untouched, burning nothing', async () => {
    const m = await mint()
    const k1 = secret('01')
    const bearer = await makeBearer(m, k1, 21_000)

    const result = await ensureExactAmount([bearer], 21_000)
    expect(noteK1(result.note.url)).toBe(k1)
    expect(result.consumed).toEqual([])
    expect(result.change).toBeUndefined()
    expect(m.state.noteState(k1)).toBe('outstanding')
  })

  it('split path: carves an exact note off a larger one, with change', async () => {
    const m = await mint()
    const k1 = secret('02')
    const bearer = await makeBearer(m, k1, 21_000)

    const result = await ensureExactAmount([bearer], 5_000)
    expect(result.note.amount).toBe(5_000)
    expect(result.note.verified).toBe(true)
    expect(result.change?.amount).toBe(16_000)
    expect(result.consumed.map(b => b.id)).toEqual([bearer.id])

    // the input is burned; both outputs are live and worth what the result claims
    expect(m.state.noteState(k1)).toBe('burned')
    const partK1 = noteK1(result.note.url)!
    const changeK1 = noteK1(result.change!.url)!
    expect((await fetchNoteInfo(noteUrl(m, partK1))).maxWithdrawable).toBe(5_000)
    expect((await fetchNoteInfo(noteUrl(m, changeK1))).maxWithdrawable).toBe(16_000)
  })

  it('merge path: combines notes summing exactly to the target', async () => {
    const m = await mint()
    const a = await makeBearer(m, secret('03'), 3_000)
    const b = await makeBearer(m, secret('04'), 4_000)

    const result = await ensureExactAmount([a, b], 7_000)
    expect(result.note.amount).toBe(7_000)
    expect(result.change).toBeUndefined()
    expect(result.consumed).toHaveLength(2)

    expect(m.state.noteState(noteK1(a.url)!)).toBe('burned')
    expect(m.state.noteState(noteK1(b.url)!)).toBe('burned')
    const mergedK1 = noteK1(result.note.url)!
    expect((await fetchNoteInfo(noteUrl(m, mergedK1))).maxWithdrawable).toBe(7_000)
  })

  it('merge+split path: splits the target off several notes in one request', async () => {
    const m = await mint()
    const a = await makeBearer(m, secret('05'), 3_000)
    const b = await makeBearer(m, secret('06'), 4_000)

    const result = await ensureExactAmount([a, b], 5_000)
    expect(result.note.amount).toBe(5_000)
    expect(result.change?.amount).toBe(2_000)
    expect(result.consumed).toHaveLength(2)

    const partK1 = noteK1(result.note.url)!
    const changeK1 = noteK1(result.change!.url)!
    expect((await fetchNoteInfo(noteUrl(m, partK1))).maxWithdrawable).toBe(5_000)
    expect((await fetchNoteInfo(noteUrl(m, changeK1))).maxWithdrawable).toBe(2_000)
  })

  it('excludes spent and unverified notes from selection', async () => {
    const m = await mint()
    const spentBearer = await makeBearer(m, secret('07'), 50_000)
    const unverified: Bearer = {
      ...(await makeBearer(m, secret('08'), 50_000)),
      callback: ''
    }
    await expect(
      ensureExactAmount([{...spentBearer, spent: true}, unverified], 5_000)
    ).rejects.toThrow(/enough/)
  })

  it('refuses an amount no mint can cover', async () => {
    const m = await mint()
    const bearer = await makeBearer(m, secret('09'), 5_000)
    await expect(ensureExactAmount([bearer], 50_000)).rejects.toThrow(/enough/)
  })

  it('rescues the fresh secrets when a split\'s answer is lost (probe: gone)', async () => {
    const m = await mint({dropAfterMutation: true})
    const k1 = secret('10')
    const bearer = await makeBearer(m, k1, 21_000)

    // the split's response never arrives - but the mutation landed, so the
    // probe resolves the ambiguity and the carried secrets are adopted
    const result = await ensureExactAmount([bearer], 5_000)
    const partK1 = noteK1(result.note.url)!
    const changeK1 = noteK1(result.change!.url)!
    expect(partK1).not.toBe(k1)
    expect(m.state.noteState(k1)).toBe('burned')
    expect((await fetchNoteInfo(noteUrl(m, partK1))).maxWithdrawable).toBe(5_000)
    expect((await fetchNoteInfo(noteUrl(m, changeK1))).maxWithdrawable).toBe(16_000)
  })

  it('surfaces the possible outputs when neither mutation nor probe can be confirmed', async () => {
    const m = await mint({dropAfterMutation: true})
    const k1 = secret('11')
    const bearer = await makeBearer(m, k1, 21_000)

    // mutations go to the mint (and land, dropped); every informational GET
    // fails, so the probe cannot resolve the ambiguity either
    const probeKillingFetch: typeof fetch = (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      if (url.includes('/w/cb')) return fetch(input, init)
      return Promise.reject(new Error('probe unreachable'))
    }
    const err = await ensureExactAmount([bearer], 5_000, {
      fetch: probeKillingFetch
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UncertainOutcomeError)
    const outputs = (err as UncertainOutcomeError).possibleOutputs
    expect(outputs).toHaveLength(2)
    // both possible outputs carry their fresh secrets, at the expected
    // amounts - if the split landed, these are the only money left
    expect(outputs[0]!.amount).toBe(5_000)
    expect(outputs[1]!.amount).toBe(16_000)
    expect((await fetchNoteInfo(noteUrl(m, noteK1(outputs[0]!.url)!))).maxWithdrawable).toBe(5_000)
    expect((await fetchNoteInfo(noteUrl(m, noteK1(outputs[1]!.url)!))).maxWithdrawable).toBe(16_000)
  })
})

describe('mint -> claim -> rotate', () => {
  it('mints a note from a paid invoice and rotates it immediately', async () => {
    const m = await mint({testHooks: true})
    const prepared = await prepareMint(`mint@127.0.0.1:${m.port}`, 21_000)
    expect(prepared.invoice).toMatch(/^lnbc/)
    expect(prepared.verifyUrl).toBeTruthy()
    expect(prepared.expectedNoteValueMsat).toBe(21_000)

    const preimage = await settleLastInvoice(m)

    const claimed = await claimMintedNote(prepared, {
      intervalMs: 10,
      intervalCapMs: 50,
      maxWaitMs: 5_000
    })
    expect(claimed.rotated).toBe(true)
    expect(claimed.note.amount).toBe(21_000)
    expect(claimed.note.verified).toBe(true)

    // the preimage IS the initial note secret - after the rotate, that
    // secret (which the mint necessarily saw) is worthless, and the
    // wallet's fresh secret is the only live note
    expect(m.state.noteState(preimage)).toBe('burned')
    const k1 = noteK1(claimed.note.url)!
    expect(k1).not.toBe(preimage)
    expect(m.state.noteState(k1)).toBe('outstanding')
  })

  it('grosses the invoice up for an advertised mint fee', async () => {
    const m = await mint({testHooks: true, baseFeeMsat: 1_000, feePpm: 2_000})
    const prepared = await prepareMint(`mint@127.0.0.1:${m.port}`, 100_000)
    expect(prepared.grossMsat).toBeGreaterThan(100_000)

    const preimage = await settleLastInvoice(m)
    // the service's fee math is authoritative - the credited note nets
    // roughly what was asked for (within fee-rounding slack), never more
    // than the gross
    const info = await fetchNoteInfo(
      buildNoteUrl(prepared.withdrawLink, preimage, prepared.expectedNoteValueMsat)
    )
    expect(info.maxWithdrawable).toBeGreaterThanOrEqual(99_000)
    expect(info.maxWithdrawable).toBeLessThanOrEqual(prepared.grossMsat)

    // this mock regenerates the proof's pr from the NET amount rather than
    // echoing the stored invoice, so the strict same-invoice guard in
    // claimMintedNote correctly refuses to bind it - the guard working as
    // designed against a mismatched proof
    await expect(
      claimMintedNote(prepared, {intervalMs: 10, intervalCapMs: 20, maxWaitMs: 500})
    ).rejects.toThrow(/different invoice/)
  })

  it('times out cleanly when the invoice is never paid', async () => {
    const m = await mint({testHooks: true})
    const prepared = await prepareMint(`mint@127.0.0.1:${m.port}`, 21_000)
    await expect(
      claimMintedNote(prepared, {intervalMs: 10, intervalCapMs: 20, maxWaitMs: 100})
    ).rejects.toThrow(/not confirmed/i)
  })
})

describe('receiveBearer', () => {
  it('verifies an incoming note and rotates it, burning the sender\'s copy', async () => {
    const m = await mint()
    // the "sender" hands over this URL - they know its secret
    const senderK1 = secret('20')
    m.state.creditNote(senderK1, 21_000)

    const received = await receiveBearer(noteUrl(m, senderK1, 21_000), [])
    expect(received.rotated).toBe(true)
    expect(received.note.amount).toBe(21_000)
    expect(received.note.verified).toBe(true)

    const newK1 = noteK1(received.note.url)!
    expect(newK1).not.toBe(senderK1)
    expect(m.state.noteState(senderK1)).toBe('burned')
    expect(m.state.noteState(newK1)).toBe('outstanding')
  })

  it('refuses a note the wallet already holds', async () => {
    const m = await mint()
    const senderK1 = secret('21')
    const existing = await makeBearer(m, senderK1, 21_000)
    await expect(
      receiveBearer(noteUrl(m, senderK1, 21_000), [existing])
    ).rejects.toThrow(/already/)
  })

  it('surfaces a spent note as definitively spent', async () => {
    const m = await mint()
    const k1 = secret('22')
    const bearer = await makeBearer(m, k1, 21_000)
    // burn it server-side (a rotate by the "other" copy of the wallet)
    const info = await fetchNoteInfo(bearer.url)
    await rotateNote(info.callback, k1)

    await expect(receiveBearer(noteUrl(m, k1, 21_000), [])).rejects.toBeInstanceOf(
      NoteSpentError
    )
  })

  it('surfaces a note locked mid-melt as pending, not as unverified', async () => {
    const m = await mint({meltNeverSettles: true})
    const k1 = secret('23')
    const bearer = await makeBearer(m, k1, 21_000)
    await meltNote(bearer.callback, k1, 'lnbc21n1pjqrstuvwxyz')

    await expect(receiveBearer(noteUrl(m, k1, 21_000), [])).rejects.toBeInstanceOf(
      PendingNoteError
    )
  })
})

describe('payWithBearers', () => {
  it('pays a bolt11 invoice by melting an exact note (settled)', async () => {
    const m = await mint()
    const bearer = await makeBearer(m, secret('30'), 21_000)

    const result = await payWithBearers([bearer], 'lnbc210n1pjqrstuvwxyz', {
      poll: {intervalMs: 10, intervalCapMs: 50, maxWaitMs: 5_000}
    })
    expect(result.outcome).toBe('settled')
    expect(m.state.noteState(secret('30'))).toBe('burned')
  })

  it('pays a Lightning Address by requesting an invoice first', async () => {
    const payer = await mint()
    const payee = await mint()
    const bearer = await makeBearer(payer, secret('31'), 21_000)

    const result = await payWithBearers(
      [bearer],
      `mint@127.0.0.1:${payee.port}`,
      {amountMsat: 21_000, poll: {intervalMs: 10, intervalCapMs: 50, maxWaitMs: 5_000}}
    )
    expect(result.outcome).toBe('settled')
    expect(result.invoice).toMatch(/^lnbc/)
    expect(payer.state.noteState(secret('31'))).toBe('burned')
  })

  it('carves the exact amount out of a larger note before melting', async () => {
    const m = await mint()
    const bearer = await makeBearer(m, secret('32'), 50_000)

    const result = await payWithBearers([bearer], 'lnbc210n1pjqrstuvwxyz', {
      poll: {intervalMs: 10, intervalCapMs: 50, maxWaitMs: 5_000}
    })
    expect(result.outcome).toBe('settled')
    // the split happened: input burned, the 21000 sat note melted, and the
    // change note is tracked for the wallet to keep
    expect(m.state.noteState(secret('32'))).toBe('burned')
    expect(result.carve.consumed.map(b => b.id)).toEqual([bearer.id])
    expect(result.carve.change?.amount).toBe(29_000)
    expect(m.state.noteState(noteK1(result.carve.change!.url)!)).toBe('outstanding')
  })

  it('classifies a failed melt as funds-returned once the note is spendable again', async () => {
    const m = await mint({meltAlwaysFails: true})
    const bearer = await makeBearer(m, secret('33'), 21_000)

    const result = await payWithBearers([bearer], 'lnbc210n1pjqrstuvwxyz', {
      poll: {intervalMs: 10, intervalCapMs: 20, maxWaitMs: 300}
    })
    expect(result.outcome).toBe('failed-funds-returned')
    // the mint restored the note, and the classification rotate re-secured
    // it (the melt had put its k1 on the wire): the old secret is burned,
    // the fresh one in the result is outstanding at the full amount
    expect(m.state.noteState(secret('33'))).toBe('burned')
    const returnedK1 = noteK1(result.carve.note.url)!
    expect(m.state.noteState(returnedK1)).toBe('outstanding')
    expect(result.carve.note.amount).toBe(21_000)
  })

  it('classifies a never-settling melt as unknown-still-pending', async () => {
    const m = await mint({meltNeverSettles: true})
    const bearer = await makeBearer(m, secret('34'), 21_000)

    const result = await payWithBearers([bearer], 'lnbc210n1pjqrstuvwxyz', {
      poll: {intervalMs: 10, intervalCapMs: 20, maxWaitMs: 300}
    })
    expect(result.outcome).toBe('unknown-still-pending')
    expect(m.state.noteState(secret('34'))).toBe('pending')
  })

  it('rejects an amountless or unreadable invoice instead of guessing', async () => {
    const m = await mint()
    const bearer = await makeBearer(m, secret('35'), 21_000)
    await expect(
      payWithBearers([bearer], 'lnbc1pjqrstuvwxyz')
    ).rejects.toThrow(/amount/)
    await expect(
      payWithBearers([bearer], 'not-an-invoice')
    ).rejects.toThrow(/not a valid/i)
  })
})

describe('transferBetweenMints', () => {
  const fastPoll = {intervalMs: 10, intervalCapMs: 50, maxWaitMs: 5_000}

  it('moves value to another mint: melt at source, claim + rotate at target', async () => {
    const source = await mint()
    const target = await mint({testHooks: true})
    const k1 = secret('40')
    const bearer = await makeBearer(source, k1, 21_000)

    const pending = transferBetweenMints(
      [bearer],
      21_000,
      `mint@127.0.0.1:${target.port}`,
      {poll: fastPoll}
    )
    // the transfer is now waiting on the target invoice settling - the
    // mock mints can't actually pay each other, so the settle hook plays
    // the melt's payment arriving
    const preimage = await settleWhenRequested(target)
    const result = await pending

    expect(result.outcome).toBe('settled')
    expect(result.invoice).toMatch(/^lnbc/)
    expect(result.quote).toEqual({
      requestedMsat: 21_000,
      grossMsat: 21_000,
      targetMintFeeMsat: 0,
      sourceMeltFeeReserveMsat: 0
    })
    expect(result.sourceServer).not.toBe(result.targetServer)
    await expectBurned(source, k1)

    const claimed = result.mintedAtTarget!
    expect(claimed.rotated).toBe(true)
    expect(claimed.note.amount).toBe(21_000)
    expect(claimed.note.verified).toBe(true)
    // the preimage is the secret the target mint necessarily saw - after
    // the rotate it is worthless there, and the wallet's fresh secret is
    // the only live note
    expect(target.state.noteState(preimage)).toBe('burned')
    const newK1 = noteK1(claimed.note.url)!
    expect(newK1).not.toBe(preimage)
    expect(target.state.noteState(newK1)).toBe('outstanding')
  })

  it('refuses an amount no source mint can cover', async () => {
    const source = await mint()
    const target = await mint()
    const k1 = secret('41')
    const bearer = await makeBearer(source, k1, 5_000)

    await expect(
      transferBetweenMints([bearer], 50_000, `mint@127.0.0.1:${target.port}`)
    ).rejects.toThrow(/enough/)
    expect(source.state.noteState(k1)).toBe('outstanding')
  })

  it('rejects a transfer onto the mint the notes are already on', async () => {
    const m = await mint()
    const k1 = secret('42')
    const bearer = await makeBearer(m, k1, 21_000)

    await expect(
      transferBetweenMints([bearer], 21_000, `mint@127.0.0.1:${m.port}`)
    ).rejects.toThrow(/different target/)
    expect(m.state.noteState(k1)).toBe('outstanding')
  })

  it('moves nothing when the target mint is unreachable', async () => {
    const source = await mint()
    // not via the mint() helper - a dead server stays out of afterEach
    const dead = await createMockMint()
    const deadAddress = `mint@127.0.0.1:${dead.port}`
    await dead.close()
    const k1 = secret('43')
    // a note LARGER than the transfer amount, so a premature carve would
    // show up here as a burn
    const bearer = await makeBearer(source, k1, 50_000)

    await expect(
      transferBetweenMints([bearer], 21_000, deadAddress)
    ).rejects.toThrow()
    expect(source.state.noteState(k1)).toBe('outstanding')
  })

  it('recovers from a melt whose answer was lost once the target invoice settles', async () => {
    // unconfirmedMutation: the melt's response confirms nothing, so the
    // melt's outcome is uncertain - the target invoice settling is the
    // transfer's ground truth
    const source = await mint({unconfirmedMutation: true})
    const target = await mint({testHooks: true})
    const k1 = secret('44')
    const bearer = await makeBearer(source, k1, 21_000)

    const pending = transferBetweenMints(
      [bearer],
      21_000,
      `mint@127.0.0.1:${target.port}`,
      {poll: fastPoll}
    )
    await settleWhenRequested(target)
    const result = await pending

    expect(result.outcome).toBe('settled')
    // the melt had landed despite its lost answer - the source note is
    // gone, and the target note came out the other end
    await expectBurned(source, k1)
    expect(result.mintedAtTarget?.note.amount).toBe(21_000)
    expect(result.mintedAtTarget?.rotated).toBe(true)
  })

  it('surfaces the claimable preimage note when the claim fails after a settled melt', async () => {
    // echoWrongK1: the target settles the invoice and reveals the
    // preimage, but its informational GET then breaks the claim
    const source = await mint()
    const target = await mint({testHooks: true, echoWrongK1: true})
    const k1 = secret('45')
    const bearer = await makeBearer(source, k1, 21_000)

    const pending = transferBetweenMints(
      [bearer],
      21_000,
      `mint@127.0.0.1:${target.port}`,
      {poll: fastPoll}
    )
    const preimage = await settleWhenRequested(target)
    const result = await pending

    expect(result.outcome).toBe('settled-claim-failed')
    await expectBurned(source, k1)
    // the preimage IS the note secret - surfaced unverified, not lost
    const note = result.claimMaterial?.note
    expect(note).toBeDefined()
    expect(noteK1(note!.url)).toBe(preimage)
    expect(note!.verified).toBe(false)
    expect(note!.amount).toBe(21_000)
    expect(result.claimMaterial?.withdrawLink).toContain(`${target.port}`)
  })

  it('grosses the carve up for the target mint fee, refusing when only the net is covered', async () => {
    const source = await mint()
    const target = await mint({baseFeeMsat: 1_000, feePpm: 2_000})
    const k1 = secret('46')
    // covers the requested net exactly - but not the grossed-up invoice
    const bearer = await makeBearer(source, k1, 100_000)

    await expect(
      transferBetweenMints([bearer], 100_000, `mint@127.0.0.1:${target.port}`)
    ).rejects.toThrow(/enough/)
    expect(source.state.noteState(k1)).toBe('outstanding')
  })

  it('restores the source note, re-secured, when the melt fails', async () => {
    const source = await mint({meltAlwaysFails: true})
    const target = await mint({testHooks: true})
    const k1 = secret('47')
    const bearer = await makeBearer(source, k1, 21_000)

    const result = await transferBetweenMints(
      [bearer],
      21_000,
      `mint@127.0.0.1:${target.port}`,
      {poll: {intervalMs: 10, intervalCapMs: 20, maxWaitMs: 300}}
    )
    expect(result.outcome).toBe('failed-funds-returned')
    expect(result.mintedAtTarget).toBeUndefined()
    // the classification rotate re-secured the note (the melt had put its
    // k1 on the wire): the old secret is burned, the fresh one in the
    // result is outstanding at the full amount
    expect(source.state.noteState(k1)).toBe('burned')
    const returnedK1 = noteK1(result.carve.note.url)!
    expect(returnedK1).not.toBe(k1)
    expect(source.state.noteState(returnedK1)).toBe('outstanding')
    expect(result.carve.note.amount).toBe(21_000)
  })
})
