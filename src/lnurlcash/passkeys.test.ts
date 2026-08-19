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
  passkeySupported,
  readPasskeySlots,
  registerPasskey,
  removePasskey,
  rewrapAllSlots,
  unlockWithPasskey,
  unwrapLinkingKeyWithPrf,
  wrapLinkingKeyWithPrf
} from './passkeys'
import {
  decryptRecord,
  decryptSavedLinkingKey,
  deriveBearerAesKey,
  encryptRecord,
  saveLinkingKey
} from './keys'
import {stubLocalStorage} from './test-utils'

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
  private held = new Map<
    string,
    {id: Uint8Array<ArrayBuffer>; secret: Uint8Array}
  >()
  supportsPrf = true
  prfResultsOnCreate = true
  prfResultsOnGet = true
  createCalls = 0
  getCalls = 0

  create = async (
    options?: CredentialCreationOptions
  ): Promise<CeremonyCredential | null> => {
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
                ...(this.prfResultsOnCreate
                  ? {results: {first: this.prf(secret, salt)}}
                  : {})
              }
            : {}
      })
    }
  }

  // answers with the first allowed credential it holds, like a real
  // authenticator picking among allowCredentials; null when it holds none
  get = async (
    options?: CredentialRequestOptions
  ): Promise<CeremonyCredential | null> => {
    this.getCalls += 1
    const pk = options?.publicKey
    const allowed = (pk?.allowCredentials ?? []).map(d =>
      bytesToHex(toBytes(d.id))
    )
    const match = allowed.find(hex => this.held.has(hex))
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
            : {}
      })
    }
  }

  // simulates the passkey's secret changing underneath a slot (credential
  // re-created on the authenticator while the slot stayed behind)
  rotateSecret = (credentialId: string): void => {
    const held = this.held.get(credentialId)
    if (held) held.secret = crypto.getRandomValues(new Uint8Array(32))
  }

  private prf = (
    secret: Uint8Array,
    salt: BufferSource
  ): Uint8Array<ArrayBuffer> => {
    // set into a fresh array: hmac returns Uint8Array<ArrayBufferLike>,
    // which BufferSource rejects
    const out = new Uint8Array(32)
    out.set(hmac(sha256, secret, toBytes(salt)))
    return out
  }
}

beforeEach(() => {
  stubLocalStorage()
})

describe('pure wrap crypto', () => {
  it('round-trips a linking key through a PRF-derived wrap', async () => {
    const wrap = await wrapLinkingKeyWithPrf(PRF_OUTPUT, LINKING_KEY)
    const unwrapped = await unwrapLinkingKeyWithPrf(PRF_OUTPUT, wrap)
    expect(bytesToHex(unwrapped)).toBe(bytesToHex(LINKING_KEY))
  })

  it('rejects unwrap with a different PRF output', async () => {
    const wrap = await wrapLinkingKeyWithPrf(PRF_OUTPUT, LINKING_KEY)
    await expect(
      unwrapLinkingKeyWithPrf(OTHER_PRF_OUTPUT, wrap)
    ).rejects.toThrow()
  })

  it('rejects unwrap with a tampered HKDF salt', async () => {
    const wrap = await wrapLinkingKeyWithPrf(PRF_OUTPUT, LINKING_KEY)
    await expect(
      unwrapLinkingKeyWithPrf(PRF_OUTPUT, {...wrap, hkdfSalt: 'ab'.repeat(16)})
    ).rejects.toThrow()
  })

  it('rejects unwrap with a tampered ciphertext', async () => {
    const wrap = await wrapLinkingKeyWithPrf(PRF_OUTPUT, LINKING_KEY)
    const flipped = `${wrap.wrappedKey.slice(0, -2)}${
      wrap.wrappedKey.endsWith('00') ? '01' : '00'
    }`
    await expect(
      unwrapLinkingKeyWithPrf(PRF_OUTPUT, {...wrap, wrappedKey: flipped})
    ).rejects.toThrow()
  })

  it('derives wrap keys deterministically from the same PRF output and salt', async () => {
    const salt = new Uint8Array(16).fill(1)
    const a = await derivePasskeyWrapKey(PRF_OUTPUT, salt)
    const b = await derivePasskeyWrapKey(PRF_OUTPUT, salt)
    const record = await encryptRecord(a, {v: 1})
    await expect(decryptRecord(b, record)).resolves.toEqual({v: 1})
  })
})

describe('registration and unlock', () => {
  it('registers a passkey and unlocks the same linking key', async () => {
    const auth = new FakeAuthenticator()
    const slot = await registerPasskey(LINKING_KEY, {
      credentials: auth,
      name: 'laptop'
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
      note: 'still readable'
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
    await expect(
      registerPasskey(LINKING_KEY, {credentials: auth})
    ).rejects.toThrow('PRF')
    expect(hasPasskeySlots()).toBe(false)
  })

  it('throws on a cancelled registration ceremony', async () => {
    const cancelled: PasskeyCredentials = {
      create: async () => null,
      get: async () => null
    }
    await expect(
      registerPasskey(LINKING_KEY, {credentials: cancelled})
    ).rejects.toThrow('cancelled')
    expect(hasPasskeySlots()).toBe(false)
  })

  it('throws before any ceremony when no passkeys are registered', async () => {
    const auth = new FakeAuthenticator()
    await expect(unlockWithPasskey({credentials: auth})).rejects.toThrow(
      'No passkeys'
    )
    expect(auth.getCalls).toBe(0)
  })

  it('rejects unlock when the passkey returns no PRF secret', async () => {
    const auth = new FakeAuthenticator()
    await registerPasskey(LINKING_KEY, {credentials: auth})
    auth.prfResultsOnGet = false
    await expect(unlockWithPasskey({credentials: auth})).rejects.toThrow(
      'PRF secret'
    )
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
          prf: {enabled: true, results: {first: new Uint8Array(32)}}
        })
      })
    }
    await expect(unlockWithPasskey({credentials: rogue})).rejects.toThrow(
      'not registered'
    )
  })

  it('rejects unlock after the authenticator secret changed underneath the slot', async () => {
    const auth = new FakeAuthenticator()
    const slot = await registerPasskey(LINKING_KEY, {credentials: auth})
    auth.rotateSecret(slot.credentialId)
    await expect(unlockWithPasskey({credentials: auth})).rejects.toThrow()
  })
})

describe('multiple passkeys', () => {
  it('keeps slots independent: each passkey unlocks the same key', async () => {
    const laptop = new FakeAuthenticator()
    const phone = new FakeAuthenticator()
    const laptopSlot = await registerPasskey(LINKING_KEY, {
      credentials: laptop,
      name: 'laptop'
    })
    const phoneSlot = await registerPasskey(LINKING_KEY, {
      credentials: phone,
      name: 'phone'
    })
    expect(readPasskeySlots()).toHaveLength(2)
    // independent wrap keys: same plaintext, different salts and ciphertexts
    expect(laptopSlot.hkdfSalt).not.toBe(phoneSlot.hkdfSalt)
    expect(laptopSlot.wrappedKey).not.toBe(phoneSlot.wrappedKey)

    expect(bytesToHex(await unlockWithPasskey({credentials: laptop}))).toBe(
      bytesToHex(LINKING_KEY)
    )
    expect(bytesToHex(await unlockWithPasskey({credentials: phone}))).toBe(
      bytesToHex(LINKING_KEY)
    )
  })

  it('removePasskey drops exactly one slot and leaves the rest working', async () => {
    const laptop = new FakeAuthenticator()
    const phone = new FakeAuthenticator()
    const laptopSlot = await registerPasskey(LINKING_KEY, {
      credentials: laptop
    })
    await registerPasskey(LINKING_KEY, {credentials: phone})

    await expect(removePasskey(laptopSlot.credentialId)).resolves.toBe(true)
    expect(readPasskeySlots()).toHaveLength(1)

    // the removed passkey no longer matches any offered credential
    await expect(unlockWithPasskey({credentials: laptop})).rejects.toThrow(
      'cancelled'
    )
    // the survivor is unaffected
    expect(bytesToHex(await unlockWithPasskey({credentials: phone}))).toBe(
      bytesToHex(LINKING_KEY)
    )
    // removing again is a no-op
    await expect(removePasskey(laptopSlot.credentialId)).resolves.toBe(false)
  })
})

describe('rewrap on linking-key rotation', () => {
  it('re-wraps every slot onto the new key, all-or-nothing', async () => {
    const laptop = new FakeAuthenticator()
    const phone = new FakeAuthenticator()
    const laptopSlot = await registerPasskey(LINKING_KEY, {
      credentials: laptop
    })
    const phoneSlot = await registerPasskey(LINKING_KEY, {
      credentials: phone
    })

    // partial coverage aborts before writing: both slots still unwrap the
    // OLD key afterwards
    const partial = new Map([
      [
        laptopSlot.credentialId,
        await getPasskeyPrfOutput(laptopSlot.credentialId, {
          credentials: laptop
        })
      ]
    ])
    await expect(rewrapAllSlots(OTHER_LINKING_KEY, partial)).rejects.toThrow(
      'partial re-wrap'
    )
    expect(bytesToHex(await unlockWithPasskey({credentials: laptop}))).toBe(
      bytesToHex(LINKING_KEY)
    )

    // full coverage: both slots now unwrap the NEW key
    const fresh = new Map([
      [
        laptopSlot.credentialId,
        await getPasskeyPrfOutput(laptopSlot.credentialId, {
          credentials: laptop
        })
      ],
      [
        phoneSlot.credentialId,
        await getPasskeyPrfOutput(phoneSlot.credentialId, {
          credentials: phone
        })
      ]
    ])
    await rewrapAllSlots(OTHER_LINKING_KEY, fresh)
    expect(bytesToHex(await unlockWithPasskey({credentials: laptop}))).toBe(
      bytesToHex(OTHER_LINKING_KEY)
    )
    expect(bytesToHex(await unlockWithPasskey({credentials: phone}))).toBe(
      bytesToHex(OTHER_LINKING_KEY)
    )
    // credential ids and labels survive the re-wrap
    expect(readPasskeySlots().map(s => s.credentialId).sort()).toEqual(
      [laptopSlot.credentialId, phoneSlot.credentialId].sort()
    )
  })
})

describe('slot storage hygiene', () => {
  it('drops malformed entries instead of throwing', async () => {
    const auth = new FakeAuthenticator()
    const slot = await registerPasskey(LINKING_KEY, {credentials: auth})
    const stored: unknown[] = JSON.parse(
      localStorage.getItem('sattle_passkey_slots') ?? '[]'
    ) as unknown[]
    localStorage.setItem(
      'sattle_passkey_slots',
      JSON.stringify([...stored, {credentialId: 'zz', hkdfSalt: 1}, 'garbage', null])
    )
    expect(readPasskeySlots()).toEqual([slot])
  })

  it('treats unparseable storage as empty', () => {
    localStorage.setItem('sattle_passkey_slots', '{not json')
    expect(readPasskeySlots()).toEqual([])
    expect(hasPasskeySlots()).toBe(false)
  })
})

describe('passkeySupported', () => {
  it('is false without a PublicKeyCredential probe', async () => {
    // node test env has no PublicKeyCredential global: the default lookup
    // finds nothing
    await expect(passkeySupported()).resolves.toBe(false)
  })

  it('is false without a user-verifying platform authenticator', async () => {
    await expect(
      passkeySupported({
        isUserVerifyingPlatformAuthenticatorAvailable: async () => false,
        getClientCapabilities: async () => ({'extension:prf': true})
      })
    ).resolves.toBe(false)
  })

  it('checks extension:prf when client capabilities are available', async () => {
    const platform = {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => true
    }
    await expect(
      passkeySupported({
        ...platform,
        getClientCapabilities: async () => ({'extension:prf': true})
      })
    ).resolves.toBe(true)
    await expect(
      passkeySupported({
        ...platform,
        getClientCapabilities: async () => ({'extension:prf': false})
      })
    ).resolves.toBe(false)
  })

  it('is optimistic when capabilities cannot be pre-detected', async () => {
    await expect(
      passkeySupported({
        isUserVerifyingPlatformAuthenticatorAvailable: async () => true
      })
    ).resolves.toBe(true)
  })
})
