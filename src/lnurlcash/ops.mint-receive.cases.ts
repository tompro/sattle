import {describe, expect, it} from 'vitest'
import {
  NoteSpentError,
  PendingNoteError,
  fetchNoteInfo,
  meltNote,
  noteK1,
  rotateNote,
} from 'lnurlcash-kit'

import {
  claimMintedNote,
  OutputSecretAllocationRequiredError,
  prepareMint,
  receiveBearer,
  ReceiveRotationStagingRequiredError,
} from './ops'
import {requiredValue} from './test-utils'
import type {NewBearer} from './types'
import {
  allocateOutputSecrets,
  makeBearer,
  mint,
  noteUrl,
  persistOutput,
  secret,
  settleLastInvoice,
  stageRotation,
} from './ops.testHarness'

describe('mint fee', () => {
  it('grosses the invoice up for an advertised mint fee', async () => {
    const instance = await mint({testHooks: true, baseFeeMsat: 1_000, feePpm: 2_000})
    const prepared = await prepareMint(`mint@127.0.0.1:${instance.port}`, 100_000, {
      persistOutput,
      allocateOutputSecrets,
    })
    expect(prepared.grossMsat).toBeGreaterThan(100_000)
    await settleLastInvoice(instance)
    const claimed = await claimMintedNote(prepared, {
      intervalMs: 10,
      intervalCapMs: 20,
      maxWaitMs: 5_000,
    })
    // the service's maxWithdrawable is authoritative: the fee is withheld
    // from the gross, so the note nets between the asked value and the gross
    expect(claimed.note.amount).toBeGreaterThanOrEqual(99_000)
    expect(claimed.note.amount).toBeLessThanOrEqual(prepared.grossMsat)
  })
})

describe('receiveBearer', () => {
  it('stages the rotation output before the rotate can reach the mint', async () => {
    const instance = await mint()
    const senderK1 = secret('94')
    instance.state.creditNote(senderK1, 21_000)
    const rotationSecret = secret('95')
    let staged: NewBearer | undefined
    const observingFetch: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/w/cb')) expect(staged).toBeDefined()
      return fetch(input, init)
    }

    const received = await receiveBearer(noteUrl(instance, senderK1, 21_000), [], {
      fetch: observingFetch,
      allocateOutputSecrets: () => Promise.resolve([rotationSecret]),
      stageRotation: (note) => {
        staged = note
      },
    })

    expect(received.stage).toBe('finalize')
    expect(received.rotated).toBe(true)
    expect(noteK1(received.note.url)).toBe(rotationSecret)
    expect(noteK1(requiredValue(staged).url)).toBe(rotationSecret)
    expect(requiredValue(staged).verified).toBe(false)
    expect(requiredValue(staged).pendingMint?.sourceRecoverySecret).toBe(senderK1)
    expect(instance.state.noteState(senderK1)).toBe('burned')
    expect(instance.state.noteState(rotationSecret)).toBe('outstanding')
  })

  it('reports discard when the rotate provably never landed', async () => {
    const instance = await mint()
    const senderK1 = secret('96')
    instance.state.creditNote(senderK1, 21_000)
    const rotationSecret = secret('97')
    let staged: NewBearer | undefined
    const failingFetch: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/w/cb')) return Promise.reject(new Error('connection reset'))
      return fetch(input, init)
    }

    const received = await receiveBearer(noteUrl(instance, senderK1, 21_000), [], {
      fetch: failingFetch,
      allocateOutputSecrets: () => Promise.resolve([rotationSecret]),
      stageRotation: (note) => {
        staged = note
      },
    })

    expect(received.stage).toBe('discard')
    expect(received.rotated).toBe(false)
    expect(received.note.verified).toBe(true)
    expect(received.rotationError).toBeDefined()
    // nothing landed: both the sender's copy and the would-be output live on
    expect(instance.state.noteState(senderK1)).toBe('outstanding')
    expect(instance.state.noteState(rotationSecret)).toBeNull()
    expect(staged).toBeDefined()
  })

  it("verifies an incoming note and rotates it, burning the sender's copy", async () => {
    const instance = await mint()
    const senderK1 = secret('20')
    instance.state.creditNote(senderK1, 21_000)
    const received = await receiveBearer(noteUrl(instance, senderK1, 21_000), [], {
      allocateOutputSecrets,
      stageRotation,
    })
    expect(received.rotated).toBe(true)
    expect(received.stage).toBe('finalize')
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
    await expect(
      receiveBearer(noteUrl(instance, k1, 21_000), [], {
        allocateOutputSecrets,
        stageRotation,
      }),
    ).rejects.toBeInstanceOf(PendingNoteError)
  })

  it('refuses to rotate without a durable staging checkpoint', async () => {
    const instance = await mint()
    const senderK1 = secret('9a')
    instance.state.creditNote(senderK1, 21_000)

    await expect(
      receiveBearer(noteUrl(instance, senderK1, 21_000), [], {allocateOutputSecrets}),
    ).rejects.toBeInstanceOf(ReceiveRotationStagingRequiredError)
    // the sender's copy is untouched - no rotation was attempted
    expect(instance.state.noteState(senderK1)).toBe('outstanding')
  })

  it('refuses to rotate without an allocation path', async () => {
    const instance = await mint()
    const senderK1 = secret('9b')
    instance.state.creditNote(senderK1, 21_000)

    await expect(
      receiveBearer(noteUrl(instance, senderK1, 21_000), [], {stageRotation}),
    ).rejects.toBeInstanceOf(OutputSecretAllocationRequiredError)
    expect(instance.state.noteState(senderK1)).toBe('outstanding')
  })
})
