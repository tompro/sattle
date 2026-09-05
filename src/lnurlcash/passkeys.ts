// Passkey (WebAuthn PRF) unlock is an alternative wrap of the complete
// canonical wallet material protected by the password path. Slot ownership
// remains derived only from the linking key inside that material.
//
// No master-key indirection is introduced: unlike Bitwarden, this wallet
// persists one authenticated material envelope. The password wrap and each
// passkey slot are independent wraps of those same canonical bytes.
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
  PASSKEY_SLOT_VERSION,
  passkeySlotsEqual,
  readPasskeySlots,
  requireCurrentPasskeyMaterialOwner,
  writePasskeySlots,
} from './storage/passkeySlots'
import type {WalletMaterialV2} from './storage/storedSecret'
import {walletMaterialHash, walletMaterialOwnerId} from './storage/storedSecret'
import {savedWalletMaterialHash, savedWalletMaterialOwnerId} from './walletMaterialStorage'
import {unwrapWalletMaterialWithPrf, wrapWalletMaterialWithPrf} from './passkeyWrap'

export type {PasskeySlot, PasskeyWrap} from './storage/passkeySlots'
export {readPasskeySlots, hasPasskeySlots} from './storage/passkeySlots'
export {migrateLegacyPasskeySlots} from './passkeyOwnership'
export {rewrapAllSlots} from './passkeyRewrap'
export {
  derivePasskeyWrapKey,
  InvalidPasskeyMaterialError,
  wrapWalletMaterialWithPrf,
  unwrapWalletMaterialWithPrf,
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
  create(options?: CredentialCreationOptions): Promise<CeremonyCredential | null>
  get(options?: CredentialRequestOptions): Promise<CeremonyCredential | null>
}

export type PasskeySupportProbe = {
  isUserVerifyingPlatformAuthenticatorAvailable(): Promise<boolean>
  getClientCapabilities?(): Promise<Record<string, boolean>>
}

// the one runtime narrow at the browser boundary: navigator.credentials
// resolves to the Credential supertype, but a publicKey ceremony always
// produces a PublicKeyCredential
const asCeremonyCredential = (credential: Credential | null): CeremonyCredential | null => {
  if (typeof PublicKeyCredential === 'undefined' || !(credential instanceof PublicKeyCredential)) {
    return null
  }
  return credential
}

const defaultCredentials = (): PasskeyCredentials => {
  if (typeof navigator === 'undefined' || !navigator.credentials) {
    throw new Error('WebAuthn is not available in this environment.')
  }
  const container = navigator.credentials
  return {
    create: (options) => container.create(options).then(asCeremonyCredential),
    get: (options) => container.get(options).then(asCeremonyCredential),
  }
}

// Feature detection: a user-verifying platform authenticator (Touch ID,
// Windows Hello, Android biometrics) plus the PRF extension. PRF has no
// direct pre-flight check on older clients - where getClientCapabilities
// exists we can ask for it, elsewhere this returns true optimistically and
// registration itself fails with a clear error.
export const passkeySupported = async (probe?: PasskeySupportProbe): Promise<boolean> => {
  const p = probe ?? (typeof PublicKeyCredential !== 'undefined' ? PublicKeyCredential : undefined)
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
// PRF output - the building block for complete-material re-wrap ceremonies
export const getPasskeyPrfOutput = async (
  credentialId: string,
  options: {credentials?: PasskeyCredentials} = {},
): Promise<Uint8Array> => {
  const credentials = options.credentials ?? defaultCredentials()
  const assertion = await credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{type: 'public-key', id: new Uint8Array(hexToBytes(credentialId))}],
      userVerification: 'required',
      extensions: {prf: {eval: {first: PASSKEY_PRF_SALT}}},
    },
  })
  if (!assertion) throw new Error('Passkey ceremony was cancelled.')
  const prfOutput = prfOutputOf(assertion)
  if (!prfOutput) {
    throw new Error('This passkey did not return a PRF secret - it cannot unlock this wallet.')
  }
  return prfOutput
}

export type RegisterPasskeyOptions = {
  credentials?: PasskeyCredentials
  name?: string
  authenticatorAttachment?: AuthenticatorAttachment
}

// Registers a new passkey and persists a slot wrapping the complete material.
// The ceremony is navigator.credentials.create with the PRF
// extension evaluated on creation. Some authenticators only report
// prf.enabled during create and evaluate the secret on the first get -
// those get a follow-up get() against the fresh credential.
export const registerPasskey = async (
  material: WalletMaterialV2,
  options: RegisterPasskeyOptions = {},
): Promise<PasskeySlot> => {
  const ownerId = requireCurrentPasskeyMaterialOwner(material)
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
        displayName: 'sattle wallet',
      },
      pubKeyCredParams: [
        {type: 'public-key', alg: -7}, // ES256
        {type: 'public-key', alg: -257}, // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: options.authenticatorAttachment ?? 'platform',
        residentKey: 'preferred',
        userVerification: 'required',
      },
      attestation: 'none',
      extensions: {prf: {eval: {first: PASSKEY_PRF_SALT}}},
    },
  })
  if (!credential) throw new Error('Passkey registration was cancelled.')
  const credentialId = bytesToHex(toBytes(credential.rawId))
  let prfOutput = prfOutputOf(credential)
  if (!prfOutput) {
    if (credential.getClientExtensionResults().prf?.enabled !== true) {
      throw new Error('This authenticator does not support the WebAuthn PRF extension.')
    }
    prfOutput = await getPasskeyPrfOutput(credentialId, {credentials})
  }
  const wrap = await wrapWalletMaterialWithPrf(prfOutput, material)
  const slot: PasskeySlot = {
    credentialId,
    ...wrap,
    createdAt: Date.now(),
    ...(options.name !== undefined ? {name: options.name} : {}),
    ownerId,
    version: PASSKEY_SLOT_VERSION,
  }
  await withStorageLock(PASSKEY_SLOTS_STORAGE_KEY, () => {
    if (requireCurrentPasskeyMaterialOwner(material) !== ownerId) {
      throw new Error('Saved wallet material changed during passkey registration.')
    }
    const slots = readPasskeySlots().filter((s) => s.credentialId !== credentialId)
    slots.push(slot)
    writePasskeySlots(ownerId, slots)
  })
  return slot
}

// Unlocks complete material via one get() ceremony offering every current
// slot. The selected slot is re-read after the ceremony before any plaintext
// reaches the caller, rejecting owner or storage changes during user presence.
export const unlockWalletMaterialWithPasskey = async (
  options: {credentials?: PasskeyCredentials} = {},
): Promise<WalletMaterialV2> => {
  const ownerId = savedWalletMaterialOwnerId()
  const materialHash = savedWalletMaterialHash()
  const slots = readPasskeySlots()
  if (ownerId === null || materialHash === null || slots.length === 0) {
    throw new Error('No passkeys registered on this device.')
  }
  if (slots.some((slot) => slot.materialHash !== materialHash)) {
    throw new Error('Passkey slot belongs to different wallet material.')
  }
  const credentials = options.credentials ?? defaultCredentials()
  const assertion = await credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: slots.map((slot) => ({
        type: 'public-key',
        id: new Uint8Array(hexToBytes(slot.credentialId)),
      })),
      userVerification: 'required',
      extensions: {prf: {eval: {first: PASSKEY_PRF_SALT}}},
    },
  })
  if (!assertion) throw new Error('Passkey ceremony was cancelled.')
  const credentialId = bytesToHex(toBytes(assertion.rawId))
  const slot = slots.find((s) => s.credentialId === credentialId)
  if (!slot) {
    throw new Error('The passkey used is not registered with this wallet.')
  }
  const prfOutput = prfOutputOf(assertion)
  if (!prfOutput) {
    throw new Error('This passkey did not return a PRF secret - it cannot unlock this wallet.')
  }
  if (savedWalletMaterialOwnerId() !== ownerId) {
    throw new Error('This passkey belongs to a different wallet.')
  }
  if (savedWalletMaterialHash() !== materialHash) {
    throw new Error('Saved wallet material changed during the unlock ceremony.')
  }
  const currentSlot = readPasskeySlots().find((candidate) => candidate.credentialId === credentialId)
  if (currentSlot === undefined || !passkeySlotsEqual(slot, currentSlot)) {
    throw new Error('The passkey slot changed during the unlock ceremony.')
  }
  const material = await unwrapWalletMaterialWithPrf(prfOutput, currentSlot)
  if (savedWalletMaterialOwnerId() !== ownerId || walletMaterialOwnerId(material) !== ownerId) {
    throw new Error('This passkey belongs to a different wallet.')
  }
  if (savedWalletMaterialHash() !== materialHash || walletMaterialHash(material) !== materialHash) {
    throw new Error('Saved wallet material changed during the unlock ceremony.')
  }
  return material
}

// Removes the slot only: WebAuthn has no API to delete the credential from
// the authenticator - an orphaned passkey simply finds nothing to unwrap.
// Returns whether a slot was actually removed.
export const removePasskey = async (credentialId: string): Promise<boolean> => {
  const ownerId = savedWalletMaterialOwnerId()
  if (ownerId === null) return false
  let removed = false
  await withStorageLock(PASSKEY_SLOTS_STORAGE_KEY, () => {
    const slots = readPasskeySlots()
    const kept = slots.filter((s) => s.credentialId !== credentialId)
    removed = kept.length !== slots.length
    if (removed) writePasskeySlots(ownerId, kept)
  })
  return removed
}
