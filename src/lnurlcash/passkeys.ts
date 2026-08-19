// Passkey (WebAuthn PRF) unlock: an ALTERNATIVE wrap of the same linking
// key the password path protects (keys.ts) - never a second key, so notes
// encrypted under a password unlock stay readable after a passkey unlock
// and vice versa (both yield the identical linking key, from which the
// bearer AES key derives).
//
// No master-key indirection is introduced: unlike Bitwarden, this wallet
// persists exactly one secret - the seed-derived linking key - and the
// bearer-encryption key is derived from it (not wrapped by it), so a random
// master key would only ever encrypt that one 32-byte value while forcing a
// migration of every existing store. The linking key IS the "master key"
// here: the password wrap (keys.ts) and each passkey slot below are
// independent wraps of the same key material.
//
// The module is split into a pure-crypto core (passkeyWrap.ts: HKDF from a
// PRF output to an AES-GCM wrap key, slot wrap/unwrap - fully unit-tested)
// and a thin WebAuthn glue layer whose credentials container is injected,
// so tests drive the ceremonies with a fake authenticator. Slot records
// live in storage/passkeySlots.ts.
//
// PRF salt strategy: one FIXED 32-byte salt for every slot. A get()
// ceremony can evaluate only one prf.eval input for whichever credential
// the authenticator ends up using, and per-credential evalByCredential is
// not widely implemented - a shared salt keeps multi-passkey unlock a
// single ceremony. The salt is not a secret: the PRF output is HMAC over
// the authenticator's per-credential secret, so each passkey still yields
// an independent, unguessable wrap secret. A per-slot random HKDF salt then
// separates the actual wrap keys.

import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'

import {withStorageLock} from './storageLock'
import type {PasskeySlot} from './storage/passkeySlots'
import {
  PASSKEY_SLOTS_STORAGE_KEY,
  readPasskeySlots,
  writePasskeySlots
} from './storage/passkeySlots'
import {unwrapLinkingKeyWithPrf, wrapLinkingKeyWithPrf} from './passkeyWrap'

export type {PasskeySlot, PasskeyWrap} from './storage/passkeySlots'
export {readPasskeySlots, hasPasskeySlots} from './storage/passkeySlots'
export {
  derivePasskeyWrapKey,
  wrapLinkingKeyWithPrf,
  unwrapLinkingKeyWithPrf
} from './passkeyWrap'

// 32 bytes, fixed - the authenticator requires exactly 32
const PASSKEY_PRF_SALT = sha256(utf8ToBytes('sattle-passkey-prf-v1'))

// ---- WebAuthn glue (browser-only; credentials container injected) ----

// the structural slice of a PublicKeyCredential the engine consumes - a
// fake authenticator in tests implements exactly this
export type CeremonyCredential = {
  type: string
  rawId: BufferSource
  getClientExtensionResults(): AuthenticationExtensionsClientOutputs
}

// the slice of navigator.credentials the ceremonies need
export type PasskeyCredentials = {
  create(
    options?: CredentialCreationOptions
  ): Promise<CeremonyCredential | null>
  get(options?: CredentialRequestOptions): Promise<CeremonyCredential | null>
}

export type PasskeySupportProbe = {
  isUserVerifyingPlatformAuthenticatorAvailable(): Promise<boolean>
  getClientCapabilities?(): Promise<Record<string, boolean>>
}

// the one runtime narrow at the browser boundary: navigator.credentials
// resolves to the Credential supertype, but a publicKey ceremony always
// produces a PublicKeyCredential
const asCeremonyCredential = (
  credential: Credential | null
): CeremonyCredential | null => {
  if (!credential || credential.type !== 'public-key') return null
  if (!('rawId' in credential)) return null
  if (!('getClientExtensionResults' in credential)) return null
  return credential as unknown as CeremonyCredential
}

const defaultCredentials = (): PasskeyCredentials => {
  if (typeof navigator === 'undefined' || !navigator.credentials) {
    throw new Error('WebAuthn is not available in this environment.')
  }
  const container = navigator.credentials
  return {
    create: options => container.create(options).then(asCeremonyCredential),
    get: options => container.get(options).then(asCeremonyCredential)
  }
}

// Feature detection: a user-verifying platform authenticator (Touch ID,
// Windows Hello, Android biometrics) plus the PRF extension. PRF has no
// direct pre-flight check on older clients - where getClientCapabilities
// exists we can ask for it, elsewhere this returns true optimistically and
// registration itself fails with a clear error.
export const passkeySupported = async (
  probe?: PasskeySupportProbe
): Promise<boolean> => {
  const p =
    probe ??
    (typeof PublicKeyCredential !== 'undefined'
      ? PublicKeyCredential
      : undefined)
  if (!p) return false
  if (!(await p.isUserVerifyingPlatformAuthenticatorAvailable())) return false
  if (p.getClientCapabilities) {
    const capabilities = await p.getClientCapabilities()
    return capabilities['extension:prf'] === true
  }
  return true
}

const toBytes = (source: BufferSource): Uint8Array =>
  source instanceof ArrayBuffer
    ? new Uint8Array(source)
    : new Uint8Array(source.buffer, source.byteOffset, source.byteLength)

// pulls the evaluated PRF secret out of a ceremony result; null when the
// authenticator did not evaluate the extension (no hmac-secret support)
const prfOutputOf = (credential: CeremonyCredential): Uint8Array | null => {
  const first = credential.getClientExtensionResults().prf?.results?.first
  return first ? toBytes(first) : null
}

// one get() ceremony against a single known credential, returning its fresh
// PRF output - the building block for re-wrap ceremonies during linking-key
// rotation
export const getPasskeyPrfOutput = async (
  credentialId: string,
  options: {credentials?: PasskeyCredentials} = {}
): Promise<Uint8Array> => {
  const credentials = options.credentials ?? defaultCredentials()
  const assertion = await credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [
        {type: 'public-key', id: new Uint8Array(hexToBytes(credentialId))}
      ],
      userVerification: 'required',
      extensions: {prf: {eval: {first: PASSKEY_PRF_SALT}}}
    }
  })
  if (!assertion) throw new Error('Passkey ceremony was cancelled.')
  const prfOutput = prfOutputOf(assertion)
  if (!prfOutput) {
    throw new Error(
      'This passkey did not return a PRF secret - it cannot unlock this wallet.'
    )
  }
  return prfOutput
}

export type RegisterPasskeyOptions = {
  credentials?: PasskeyCredentials
  name?: string
  authenticatorAttachment?: AuthenticatorAttachment
}

// Registers a new passkey and persists a slot wrapping the given linking
// key. The caller supplies the linking key from the currently unlocked
// wallet; the ceremony is navigator.credentials.create with the PRF
// extension evaluated on creation. Some authenticators only report
// prf.enabled during create and evaluate the secret on the first get -
// those get a follow-up get() against the fresh credential.
export const registerPasskey = async (
  linkingKey: Uint8Array,
  options: RegisterPasskeyOptions = {}
): Promise<PasskeySlot> => {
  const credentials = options.credentials ?? defaultCredentials()
  const credential = await credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: {name: 'sattle'},
      user: {
        // random per registration: slots address credentials by id, no
        // discoverable-credential login is used
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: 'sattle wallet',
        displayName: 'sattle wallet'
      },
      pubKeyCredParams: [
        {type: 'public-key', alg: -7}, // ES256
        {type: 'public-key', alg: -257} // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: options.authenticatorAttachment ?? 'platform',
        residentKey: 'preferred',
        userVerification: 'required'
      },
      attestation: 'none',
      extensions: {prf: {eval: {first: PASSKEY_PRF_SALT}}}
    }
  })
  if (!credential) throw new Error('Passkey registration was cancelled.')
  const credentialId = bytesToHex(toBytes(credential.rawId))
  let prfOutput = prfOutputOf(credential)
  if (!prfOutput) {
    if (credential.getClientExtensionResults().prf?.enabled !== true) {
      throw new Error(
        'This authenticator does not support the WebAuthn PRF extension.'
      )
    }
    prfOutput = await getPasskeyPrfOutput(credentialId, {credentials})
  }
  const wrap = await wrapLinkingKeyWithPrf(prfOutput, linkingKey)
  const slot: PasskeySlot = {
    credentialId,
    ...wrap,
    createdAt: Date.now(),
    ...(options.name !== undefined ? {name: options.name} : {})
  }
  await withStorageLock(PASSKEY_SLOTS_STORAGE_KEY, () => {
    const slots = readPasskeySlots().filter(
      s => s.credentialId !== credentialId
    )
    slots.push(slot)
    writePasskeySlots(slots)
  })
  return slot
}

// Unlocks via any registered passkey: one get() ceremony offering every
// slot's credential, then unwrap. Yields the exact same linking key
// unlock(password) yields - the caller activates the wallet with it.
export const unlockWithPasskey = async (
  options: {credentials?: PasskeyCredentials} = {}
): Promise<Uint8Array> => {
  const slots = readPasskeySlots()
  if (slots.length === 0) {
    throw new Error('No passkeys registered on this device.')
  }
  const credentials = options.credentials ?? defaultCredentials()
  const assertion = await credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: slots.map(slot => ({
        type: 'public-key',
        id: new Uint8Array(hexToBytes(slot.credentialId))
      })),
      userVerification: 'required',
      extensions: {prf: {eval: {first: PASSKEY_PRF_SALT}}}
    }
  })
  if (!assertion) throw new Error('Passkey ceremony was cancelled.')
  const credentialId = bytesToHex(toBytes(assertion.rawId))
  const slot = slots.find(s => s.credentialId === credentialId)
  if (!slot) {
    throw new Error('The passkey used is not registered with this wallet.')
  }
  const prfOutput = prfOutputOf(assertion)
  if (!prfOutput) {
    throw new Error(
      'This passkey did not return a PRF secret - it cannot unlock this wallet.'
    )
  }
  return unwrapLinkingKeyWithPrf(prfOutput, slot)
}

// Removes the slot only: WebAuthn has no API to delete the credential from
// the authenticator - an orphaned passkey simply finds nothing to unwrap.
// Returns whether a slot was actually removed.
export const removePasskey = async (
  credentialId: string
): Promise<boolean> => {
  let removed = false
  await withStorageLock(PASSKEY_SLOTS_STORAGE_KEY, () => {
    const slots = readPasskeySlots()
    const kept = slots.filter(s => s.credentialId !== credentialId)
    removed = kept.length !== slots.length
    if (removed) writePasskeySlots(kept)
  })
  return removed
}

// Re-wraps every slot around NEW key material - needed on linking-key
// rotation (restoring a different seed while keeping the passkeys). Each
// slot's wrap secret lives only inside its authenticator, so the caller
// must supply a fresh PRF output per credential (one getPasskeyPrfOutput
// ceremony each). All-or-nothing: a slot without a PRF output aborts the
// whole re-wrap before anything is written, since a half-rewrapped set
// would keep unlocking the OLD key with the uncovered passkeys.
//
// A password change does NOT need this: the password wrap (keys.ts) and the
// passkey slots wrap the same linking key independently, so re-encrypting
// the stored key under a new password leaves every slot valid.
export const rewrapAllSlots = async (
  linkingKey: Uint8Array,
  prfOutputs: ReadonlyMap<string, Uint8Array>
): Promise<void> => {
  await withStorageLock(PASSKEY_SLOTS_STORAGE_KEY, async () => {
    const slots = readPasskeySlots()
    const rewrapped: PasskeySlot[] = []
    for (const slot of slots) {
      const prfOutput = prfOutputs.get(slot.credentialId)
      if (!prfOutput) {
        throw new Error(
          'Missing fresh PRF output for a passkey slot - refusing a partial re-wrap.'
        )
      }
      rewrapped.push({
        ...slot,
        ...(await wrapLinkingKeyWithPrf(prfOutput, linkingKey))
      })
    }
    writePasskeySlots(rewrapped)
  })
}
