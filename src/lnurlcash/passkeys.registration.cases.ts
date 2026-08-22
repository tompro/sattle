// Passkey engine tests. The WebAuthn ceremony is faked by an injected
// authenticator whose PRF output is HMAC-SHA256(credential secret, salt) -
// the real extension's exact contract: deterministic per credential+salt,
// unguessable without the authenticator. Everything except a real
// authenticator's touch is covered here.

import {beforeEach, describe, expect, it} from 'vitest'
import {hmac} from '@noble/hashes/hmac.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex} from '@noble/hashes/utils.js'

import type {CeremonyCredential, PasskeyCredentials} from './passkeys'
import {
  derivePasskeyWrapKey,
  getPasskeyPrfOutput,
  hasPasskeySlots,
  migrateLegacyPasskeySlots,
  passkeySupported,
  readPasskeySlots,
  registerPasskey,
  removePasskey,
  rewrapAllSlots,
  unlockWithPasskey,
  unwrapLinkingKeyWithPrf,
  wrapLinkingKeyWithPrf,
} from './passkeys'
import {
  decryptRecord,
  decryptSavedLinkingKey,
  deriveBearerAesKey,
  ensureSavedKeyOwner,
  encryptRecord,
  linkingPubKeyHex,
  savedKeyOwnerId,
  saveLinkingKey,
} from './keys'
import {parseJsonObject, parseJsonObjectArray, stubLocalStorage} from './test-utils'

const LINKING_KEY = new Uint8Array(32).fill(7)
const OTHER_LINKING_KEY = new Uint8Array(32).fill(9)
const PRF_OUTPUT = new Uint8Array(32).fill(3)
const OTHER_PRF_OUTPUT = new Uint8Array(32).fill(4)

const toBytes = (source: BufferSource): Uint8Array =>
  source instanceof ArrayBuffer
    ? new Uint8Array(source)
    : new Uint8Array(source.buffer, source.byteOffset, source.byteLength)

// Fake platform authenticator: holds credentials (id -> secret), evaluates
// PRF as HMAC-SHA256(secret, salt). Flags emulate the authenticator quirks
// found in the wild: PRF unsupported, results only on get, results never.
class FakeAuthenticator implements PasskeyCredentials {
  // id typed Uint8Array<ArrayBuffer>: rawId must satisfy BufferSource
  private held = new Map<string, {id: Uint8Array<ArrayBuffer>; secret: Uint8Array}>()
  supportsPrf = true
  prfResultsOnCreate = true
  prfResultsOnGet = true
  createCalls = 0
  getCalls = 0

  create = async (options?: CredentialCreationOptions): Promise<CeremonyCredential | null> => {
    this.createCalls += 1
    const salt = options?.publicKey?.extensions?.prf?.eval?.first
    const id = crypto.getRandomValues(new Uint8Array(16))
    const secret = crypto.getRandomValues(new Uint8Array(32))
    this.held.set(bytesToHex(id), {id, secret})
    return {
      type: 'public-key',
      rawId: id,
      getClientExtensionResults: () => ({
        prf:
          this.supportsPrf && salt
            ? {
                enabled: true,
                ...(this.prfResultsOnCreate ? {results: {first: this.prf(secret, salt)}} : {}),
              }
            : {},
      }),
    }
  }

  // answers with the first allowed credential it holds, like a real
  // authenticator picking among allowCredentials; null when it holds none
  get = async (options?: CredentialRequestOptions): Promise<CeremonyCredential | null> => {
    this.getCalls += 1
    const pk = options?.publicKey
    const allowed = (pk?.allowCredentials ?? []).map((d) => bytesToHex(toBytes(d.id)))
    const match = allowed.find((hex) => this.held.has(hex))
    const held = match ? this.held.get(match) : undefined
    if (!held) return null
    const salt = pk?.extensions?.prf?.eval?.first
    return {
      type: 'public-key',
      rawId: held.id,
      getClientExtensionResults: () => ({
        prf:
          salt && this.prfResultsOnGet
            ? {enabled: true, results: {first: this.prf(held.secret, salt)}}
            : {},
      }),
    }
  }

  // simulates the passkey's secret changing underneath a slot (credential
  // re-created on the authenticator while the slot stayed behind)
  rotateSecret = (credentialId: string): void => {
    const held = this.held.get(credentialId)
    if (held) held.secret = crypto.getRandomValues(new Uint8Array(32))
  }

  private prf = (secret: Uint8Array, salt: BufferSource): Uint8Array<ArrayBuffer> => {
    // set into a fresh array: hmac returns Uint8Array<ArrayBufferLike>,
    // which BufferSource rejects
    const out = new Uint8Array(32)
    out.set(hmac(sha256, secret, toBytes(salt)))
    return out
  }
}

const readRawSlots = (): Array<Record<string, unknown>> =>
  parseJsonObjectArray(localStorage.getItem('sattle_passkey_slots') ?? '[]')

const writeRawSlots = (slots: Array<Record<string, unknown>>): void => {
  localStorage.setItem('sattle_passkey_slots', JSON.stringify(slots))
}

const removeSavedOwnerMarker = (): void => {
  const stored = parseJsonObject(localStorage.getItem('sattle_linking_key') ?? '{}')
  delete stored.ownerId
  delete stored.version
  localStorage.setItem('sattle_linking_key', JSON.stringify(stored))
}

beforeEach(async () => {
  stubLocalStorage()
  await saveLinkingKey(LINKING_KEY)
})

describe('registration and unlock', () => {
  it('registers a passkey and unlocks the same linking key', async () => {
    const auth = new FakeAuthenticator()
    const slot = await registerPasskey(LINKING_KEY, {
      credentials: auth,
      name: 'laptop',
    })
    expect(slot.name).toBe('laptop')
    expect(readPasskeySlots()).toEqual([slot])
    expect(hasPasskeySlots()).toBe(true)

    const unwrapped = await unlockWithPasskey({credentials: auth})
    expect(bytesToHex(unwrapped)).toBe(bytesToHex(LINKING_KEY))
  })

  it('never stores the linking key in the clear', async () => {
    const auth = new FakeAuthenticator()
    await registerPasskey(LINKING_KEY, {credentials: auth})
    const raw = localStorage.getItem('sattle_passkey_slots')
    expect(raw).toBeTruthy()
    expect(raw).not.toContain(bytesToHex(LINKING_KEY))
  })

  it('yields the same key material unlock(password) yields', async () => {
    const linkingKey = crypto.getRandomValues(new Uint8Array(32))
    await saveLinkingKey(linkingKey, 'correct horse')
    const auth = new FakeAuthenticator()
    await registerPasskey(linkingKey, {credentials: auth})

    const viaPassword = await decryptSavedLinkingKey('correct horse')
    const viaPasskey = await unlockWithPasskey({credentials: auth})
    expect(bytesToHex(viaPasskey)).toBe(bytesToHex(viaPassword))

    // and the practical consequence: a bearer record encrypted after a
    // password unlock decrypts after a passkey unlock
    const passwordAes = await deriveBearerAesKey(viaPassword)
    const record = await encryptRecord(passwordAes, {note: 'still readable'})
    const passkeyAes = await deriveBearerAesKey(viaPasskey)
    await expect(decryptRecord(passkeyAes, record)).resolves.toEqual({
      note: 'still readable',
    })
  })

  it('falls back to a get ceremony when create only reports prf.enabled', async () => {
    const auth = new FakeAuthenticator()
    auth.prfResultsOnCreate = false
    const slot = await registerPasskey(LINKING_KEY, {credentials: auth})
    expect(auth.getCalls).toBe(1)
    const unwrapped = await unlockWithPasskey({credentials: auth})
    expect(bytesToHex(unwrapped)).toBe(bytesToHex(LINKING_KEY))
    expect(readPasskeySlots()[0]?.credentialId).toBe(slot.credentialId)
  })

  it('refuses registration when the authenticator has no PRF support', async () => {
    const auth = new FakeAuthenticator()
    auth.supportsPrf = false
    await expect(registerPasskey(LINKING_KEY, {credentials: auth})).rejects.toThrow('PRF')
    expect(hasPasskeySlots()).toBe(false)
  })

  it('throws on a cancelled registration ceremony', async () => {
    const cancelled: PasskeyCredentials = {
      create: async () => null,
      get: async () => null,
    }
    await expect(registerPasskey(LINKING_KEY, {credentials: cancelled})).rejects.toThrow(
      'cancelled',
    )
    expect(hasPasskeySlots()).toBe(false)
  })

  it('throws before any ceremony when no passkeys are registered', async () => {
    const auth = new FakeAuthenticator()
    await expect(unlockWithPasskey({credentials: auth})).rejects.toThrow('No passkeys')
    expect(auth.getCalls).toBe(0)
  })

  it('rejects unlock when the passkey returns no PRF secret', async () => {
    const auth = new FakeAuthenticator()
    await registerPasskey(LINKING_KEY, {credentials: auth})
    auth.prfResultsOnGet = false
    await expect(unlockWithPasskey({credentials: auth})).rejects.toThrow('PRF secret')
  })

  it('rejects unlock when the ceremony yields an unregistered credential', async () => {
    const auth = new FakeAuthenticator()
    await registerPasskey(LINKING_KEY, {credentials: auth})
    const rogue: PasskeyCredentials = {
      create: async () => null,
      get: async () => ({
        type: 'public-key',
        rawId: crypto.getRandomValues(new Uint8Array(16)),
        getClientExtensionResults: () => ({
          prf: {enabled: true, results: {first: new Uint8Array(32)}},
        }),
      }),
    }
    await expect(unlockWithPasskey({credentials: rogue})).rejects.toThrow('not registered')
  })

  it('rejects unlock after the authenticator secret changed underneath the slot', async () => {
    const auth = new FakeAuthenticator()
    const slot = await registerPasskey(LINKING_KEY, {credentials: auth})
    auth.rotateSecret(slot.credentialId)
    await expect(unlockWithPasskey({credentials: auth})).rejects.toThrow()
  })
})
