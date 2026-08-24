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

describe('slot ownership', () => {
  it('binds a new slot to the proven saved wallet owner', async () => {
    // Given the saved wallet has a canonical owner marker
    const auth = new FakeAuthenticator()

    // When its linking key registers a passkey
    const slot = await registerPasskey(LINKING_KEY, {credentials: auth})

    // Then the slot carries that same canonical owner
    expect(slot.ownerId).toBe(linkingPubKeyHex(LINKING_KEY))
    expect(readPasskeySlots()).toEqual([slot])
  })

  it('filters foreign, malformed, and unowned slots from reads and availability', async () => {
    // Given one valid current-owner slot plus copies with untrusted owners
    const auth = new FakeAuthenticator()
    const current = await registerPasskey(LINKING_KEY, {credentials: auth})
    const foreign = {
      ...current,
      credentialId: '11'.repeat(16),
      ownerId: linkingPubKeyHex(OTHER_LINKING_KEY),
    }
    const malformed = {
      ...current,
      credentialId: '22'.repeat(16),
      ownerId: 'not-an-owner',
    }
    const unowned = {
      credentialId: '33'.repeat(16),
      hkdfSalt: current.hkdfSalt,
      iv: current.iv,
      wrappedKey: current.wrappedKey,
      createdAt: current.createdAt,
    }
    writeRawSlots([foreign, malformed, unowned])

    // When the current wallet asks for its slots
    const slots = readPasskeySlots()

    // Then no foreign or unproven slot is exposed
    expect(slots).toEqual([])
    expect(hasPasskeySlots()).toBe(false)
  })

  it('does not offer markerless slots for passkey-first unlock', async () => {
    // Given a legacy slot and a saved key with no proven owner marker
    const auth = new FakeAuthenticator()
    await registerPasskey(LINKING_KEY, {credentials: auth})
    const legacy = readRawSlots()
    delete legacy[0]?.ownerId
    delete legacy[0]?.version
    writeRawSlots(legacy)
    removeSavedOwnerMarker()

    // When passkey unlock is attempted before another proof path
    const attempt = unlockWithPasskey({credentials: auth})

    // Then it fails before asking the authenticator
    await expect(attempt).rejects.toThrow('No passkeys')
    expect(auth.getCalls).toBe(0)
    expect(hasPasskeySlots()).toBe(false)
  })

  it('does not auto-adopt legacy slots when a foreign wallet is saved', async () => {
    // Given markerless residue from the old wallet
    const auth = new FakeAuthenticator()
    await registerPasskey(LINKING_KEY, {credentials: auth})
    const legacy = readRawSlots()
    delete legacy[0]?.ownerId
    delete legacy[0]?.version
    writeRawSlots(legacy)

    // When a different wallet is installed with its canonical owner
    await saveLinkingKey(OTHER_LINKING_KEY)

    // Then the residue stays unowned and unavailable to the new wallet
    expect(readPasskeySlots()).toEqual([])
    expect(hasPasskeySlots()).toBe(false)
    expect(readRawSlots()).toEqual(legacy)
  })

  it('adopts legacy slots only after the saved wallet owner is proven', async () => {
    // Given a legacy encrypted wallet and its markerless passkey slot
    const auth = new FakeAuthenticator()
    await registerPasskey(LINKING_KEY, {credentials: auth})
    const legacy = readRawSlots()
    delete legacy[0]?.ownerId
    delete legacy[0]?.version
    writeRawSlots(legacy)
    await saveLinkingKey(LINKING_KEY, 'correct horse')
    removeSavedOwnerMarker()

    // When migration is attempted before and then after password proof
    await expect(migrateLegacyPasskeySlots(LINKING_KEY)).rejects.toThrow('proven owner')
    const provenKey = await decryptSavedLinkingKey('correct horse')
    ensureSavedKeyOwner(provenKey)
    await migrateLegacyPasskeySlots(provenKey)

    // Then the same slot is stamped once for that proven owner and unlocks
    expect(savedKeyOwnerId()).toBe(linkingPubKeyHex(LINKING_KEY))
    expect(readPasskeySlots()).toHaveLength(1)
    expect(readPasskeySlots()[0]?.ownerId).toBe(linkingPubKeyHex(LINKING_KEY))
    await expect(unlockWithPasskey({credentials: auth})).resolves.toEqual(LINKING_KEY)
  })
})
