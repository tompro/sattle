import {describe, expect, it} from 'vitest'
import {noteK1, noteSignature} from 'lnurlcash-kit'

import {ensureExactAmount} from './ops'
import {requiredValue} from './test-utils'
import {
  allocateOutputSecrets,
  makeBearer,
  mint,
  noteUrl,
  secret,
  signatureKeysFor,
} from './ops.testHarness'
import {fetchNoteInfo} from 'lnurlcash-kit'

// Landed split/merge outputs carry the mint's signature in their URL (sig
// param), and earn verified:true only when that signature checks against a
// trusted CURRENT or PREVIOUS key for the mint. Invalid, missing, or
// wrong-key signatures - and mints with no trusted keys at all - keep the
// staged outputs unverified; the money is tracked either way (the notes
// exist at the mint), only the offline-verifiable badge is withheld.
describe('landed mutation signature verification', () => {
  it('verifies a landed split against the current key and preserves its signature', async () => {
    const instance = await mint()
    const bearer = await makeBearer(instance, secret('a0'), 21_000)

    const result = await ensureExactAmount([bearer], 5_000, {
      onCarve: () => undefined,
      allocateOutputSecrets,
      mintSignatureKeys: signatureKeysFor(instance),
    })

    expect(result.note.verified).toBe(true)
    const signature = noteSignature(result.note.url)
    expect(signature).not.toBeNull()
    expect(noteSignature(requiredValue(result.change).url)).not.toBeNull()
    // change stays unverified (its true post-fee value is unknown until a
    // refresh) even though its signature is preserved
    expect(result.change?.verified).toBe(false)
  })

  it('verifies a landed merge against the current key and preserves its signature', async () => {
    const instance = await mint()
    const first = await makeBearer(instance, secret('a1'), 3_000)
    const second = await makeBearer(instance, secret('a2'), 4_000)

    const result = await ensureExactAmount([first, second], 7_000, {
      onCarve: () => undefined,
      allocateOutputSecrets,
      mintSignatureKeys: signatureKeysFor(instance),
    })

    expect(result.note.verified).toBe(true)
    expect(noteSignature(result.note.url)).not.toBeNull()
  })

  it('verifies against the previous key after the mint rotated its signing key', async () => {
    // the mint signs every output under its RETIRED key while advertising
    // the current one - exactly the rekey window a holder must tolerate
    const instance = await mint({
      previousPrivateKey: '22'.repeat(32),
      signWithPreviousKey: true,
    })
    const bearer = await makeBearer(instance, secret('a3'), 21_000)

    const result = await ensureExactAmount([bearer], 5_000, {
      onCarve: () => undefined,
      allocateOutputSecrets,
      mintSignatureKeys: signatureKeysFor(instance),
    })

    expect(instance.state.previousPubkeys).toHaveLength(1)
    expect(result.note.verified).toBe(true)
    expect(noteSignature(result.note.url)).not.toBeNull()
  })

  it('rejects verification when the previous key is not trusted', async () => {
    const instance = await mint({
      previousPrivateKey: '22'.repeat(32),
      signWithPreviousKey: true,
    })
    const bearer = await makeBearer(instance, secret('a4'), 21_000)

    const result = await ensureExactAmount([bearer], 5_000, {
      onCarve: () => undefined,
      allocateOutputSecrets,
      // only the current key is trusted - the signature under the retired
      // key must not verify
      mintSignatureKeys: () => [instance.state.pubkey],
    })

    expect(result.note.verified).toBe(false)
    // the note and its signature are still tracked, recoverable by refresh
    expect(noteSignature(result.note.url)).not.toBeNull()
    const partK1 = requiredValue(noteK1(result.note.url))
    expect(instance.state.noteState(partK1)).toBe('outstanding')
    expect(instance.state.noteState(secret('a4'))).toBe('burned')
  })

  it('keeps a wrong-key signature staged unverified', async () => {
    const instance = await mint()
    const bearer = await makeBearer(instance, secret('a5'), 21_000)
    const stranger = await mint({privateKey: '33'.repeat(32)})

    const result = await ensureExactAmount([bearer], 5_000, {
      onCarve: () => undefined,
      allocateOutputSecrets,
      // the only trusted key on file belongs to a DIFFERENT mint
      mintSignatureKeys: () => [stranger.state.pubkey],
    })

    expect(result.note.verified).toBe(false)
    expect(noteSignature(result.note.url)).not.toBeNull()
    expect(instance.state.noteState(secret('a5'))).toBe('burned')
    expect(
      instance.state.noteState(requiredValue(noteK1(result.note.url))),
    ).toBe('outstanding')
  })

  it('keeps a landed split unsigned by the mint staged unverified and consumed', async () => {
    const instance = await mint({signatures: false})
    const k1 = secret('a6')
    const bearer = await makeBearer(instance, k1, 21_000)

    const result = await ensureExactAmount([bearer], 5_000, {
      onCarve: () => undefined,
      allocateOutputSecrets,
      mintSignatureKeys: signatureKeysFor(instance),
    })

    // the mutation landed (the kit refused the missing signature, the
    // rescue probe proved the burn): the inputs are retired, the staged
    // outputs are tracked at exactly their staged secrets, unverified
    expect(result.consumed.map((entry) => entry.id)).toEqual([bearer.id])
    expect(result.note.verified).toBe(false)
    expect(noteSignature(result.note.url)).toBeNull()
    expect(instance.state.noteState(k1)).toBe('burned')
    const partK1 = requiredValue(noteK1(result.note.url))
    expect(instance.state.noteState(partK1)).toBe('outstanding')
    expect((await fetchNoteInfo(noteUrl(instance, partK1))).maxWithdrawable).toBe(5_000)
  })

  it('never verifies a landed mutation without any trusted keys on file', async () => {
    const instance = await mint()
    const bearer = await makeBearer(instance, secret('a7'), 21_000)

    const result = await ensureExactAmount([bearer], 5_000, {
      onCarve: () => undefined,
      allocateOutputSecrets,
      // no key source at all: nothing may be trusted blindly
    })

    expect(result.note.verified).toBe(false)
    expect(noteSignature(result.note.url)).not.toBeNull()
    expect(
      instance.state.noteState(requiredValue(noteK1(result.note.url))),
    ).toBe('outstanding')
  })
})
