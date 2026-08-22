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

describe('slot ownership (continued)', () => {
  it('rejects an unwrapped key that does not match the saved proven owner', async () => {
    // Given a current-owner slot whose authenticated wrap was replaced with
    // a valid wrap of another wallet key
    const auth = new FakeAuthenticator()
    const slot = await registerPasskey(LINKING_KEY, {credentials: auth})
    const prfOutput = await getPasskeyPrfOutput(slot.credentialId, {
      credentials: auth,
    })
    const foreignWrap = await wrapLinkingKeyWithPrf(prfOutput, OTHER_LINKING_KEY)
    writeRawSlots([{...slot, ...foreignWrap}])

    // When the authenticator successfully unwraps that foreign key
    const attempt = unlockWithPasskey({credentials: auth})

    // Then owner validation rejects it before activation can receive it
    await expect(attempt).rejects.toThrow('different wallet')
  })

  it('rejects a stale unlock when the saved owner changes during the ceremony', async () => {
    // Given an authenticator that replaces the saved wallet before returning
    const auth = new FakeAuthenticator()
    await registerPasskey(LINKING_KEY, {credentials: auth})
    const stale: PasskeyCredentials = {
      create: auth.create,
      get: async (options) => {
        const credential = await auth.get(options)
        await saveLinkingKey(OTHER_LINKING_KEY)
        return credential
      },
    }

    // When the old wallet's ceremony completes after replacement
    const attempt = unlockWithPasskey({credentials: stale})

    // Then the old linking key is never returned for activation
    await expect(attempt).rejects.toThrow('different wallet')
  })

  it('does not adopt a slot carrying a malformed owner marker', async () => {
    // Given an otherwise valid slot whose owner claim is malformed
    const auth = new FakeAuthenticator()
    const slot = await registerPasskey(LINKING_KEY, {credentials: auth})
    const malformed = {...slot, ownerId: 'not-an-owner'}
    writeRawSlots([malformed])

    // When the current owner performs the legacy migration
    await migrateLegacyPasskeySlots(LINKING_KEY)

    // Then only truly markerless legacy slots are eligible
    expect(readPasskeySlots()).toEqual([])
    expect(readRawSlots()).toEqual([malformed])
  })

  it('cannot remove a foreign-owner slot', async () => {
    // Given a slot owned by another wallet remains in shared storage
    const auth = new FakeAuthenticator()
    const slot = await registerPasskey(LINKING_KEY, {credentials: auth})
    const foreign = {...slot, ownerId: linkingPubKeyHex(OTHER_LINKING_KEY)}
    writeRawSlots([foreign])

    // When the current owner asks to remove that credential id
    const removed = await removePasskey(slot.credentialId)

    // Then the foreign record is untouched
    expect(removed).toBe(false)
    expect(readRawSlots()).toEqual([foreign])
  })

  it('rewraps only current-owner slots and preserves foreign slots', async () => {
    // Given current and foreign slots share storage
    const auth = new FakeAuthenticator()
    const slot = await registerPasskey(LINKING_KEY, {credentials: auth})
    const foreign = {
      ...slot,
      credentialId: '44'.repeat(16),
      ownerId: linkingPubKeyHex(OTHER_LINKING_KEY),
    }
    writeRawSlots([slot, foreign])
    const prfOutput = await getPasskeyPrfOutput(slot.credentialId, {
      credentials: auth,
    })

    // When the current wallet rewraps its slots
    await rewrapAllSlots(LINKING_KEY, new Map([[slot.credentialId, prfOutput]]))

    // Then the foreign slot did not require output and remains byte-identical
    expect(readRawSlots()).toContainEqual(foreign)
  })
})
