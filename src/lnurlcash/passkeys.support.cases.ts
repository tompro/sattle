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
        getClientCapabilities: async () => ({'extension:prf': true}),
      }),
    ).resolves.toBe(false)
  })

  it('checks extension:prf when client capabilities are available', async () => {
    const platform = {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
    }
    await expect(
      passkeySupported({
        ...platform,
        getClientCapabilities: async () => ({'extension:prf': true}),
      }),
    ).resolves.toBe(true)
    await expect(
      passkeySupported({
        ...platform,
        getClientCapabilities: async () => ({'extension:prf': false}),
      }),
    ).resolves.toBe(false)
  })

  it('is optimistic when capabilities cannot be pre-detected', async () => {
    await expect(
      passkeySupported({
        isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
      }),
    ).resolves.toBe(true)
  })
})
