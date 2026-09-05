// Native biometric unlock: a THIRD wrap of the same canonical wallet material,
// alongside the password wrap (keys.ts) and the passkey slots (passkeys.ts).
//
// Why native: Android WebView has no usable WebAuthn platform authenticator
// for this app (passkeys need Play Services / Digital Asset Links wiring we
// cannot rely on), so the biometric path on native is a device-credential
// prompt instead of a passkey ceremony.
//
// Design (mirrors the passkey-slot construction with a biometric-specific
// HKDF domain): on enrollment a random 32-byte wrap secret is generated,
// canonical v2 material is AES-GCM-wrapped under an HKDF of that secret,
// and only the SECRET goes into biometric-gated secure
// storage (Android Keystore-backed AES-GCM via
// @aparajita/capacitor-secure-storage). The wrapped blob stays in
// localStorage as a versioned AES-GCM record, plus the linking
// pubkey as an identity check AND the SHA-256 commitment of the canonical
// saved material: restoring a DIFFERENT seed leaves a stale wrap behind,
// and so does replacing only the saved cash root with same-owner material.
// Unlocking with either must fail loudly (never activate the old wallet
// silently), so unlock verifies the record commitment and the unwrapped
// material against the saved wallet material and tells the holder to
// re-enroll.
//
// The biometric gate is app-level (a BiometricPrompt before the secure
// read), not a keystore key invalidated on biometric re-enrollment - 04
// deliberately prefers BIOMETRY_ANY/weak so adding a fingerprint doesn't
// wipe the holder's unlock. allowDeviceCredential keeps PIN/pattern as the
// system fallback.
//
// Web/PWA: every entry point reports unavailable and never touches the
// plugins' web shims (secure-storage's web impl is unencrypted localStorage
// - explicitly not for production secrets).

import {
  AndroidBiometryStrength,
  BiometricAuth,
  BiometryError,
  BiometryErrorType,
} from '@aparajita/capacitor-biometric-auth';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

import {
  getPlainWalletMaterial,
  parseWalletMaterial,
  savedWalletMaterialHash,
  savedWalletMaterialOwnerId,
  serializeWalletMaterial,
  walletMaterialHash,
  type WalletMaterialV2,
} from '@/lnurlcash/keys';
import { isJsonObject } from '@/lnurlcash/jsonParsing';
import { walletMaterialOwnerId } from '@/lnurlcash/storage/storedSecret';

import { isNative } from './platform';

type BiometricWrapRecord = {
  readonly version: 2;
  readonly hkdfSalt: string;
  readonly iv: string;
  readonly wrappedKey: string;
  readonly pubkey: string;
  readonly materialHash: string;
  readonly createdAt: number;
};

// the wrapped blob is useless without the secure-storage secret, so (like
// the passkey slots) this record sits in plain localStorage
const WRAP_RECORD_STORAGE_KEY = 'sattle_biometric_wrap';
const SECURE_SECRET_KEY = 'sattle-biometric-wrap-secret';
const BIOMETRIC_WRAP_VERSION = 2 as const;
const WRAP_KEY_HKDF_INFO = 'sattle-biometric-wrap-v2';
const WRAP_RECORD_KEYS = [
  'version',
  'hkdfSalt',
  'iv',
  'wrappedKey',
  'pubkey',
  'materialHash',
  'createdAt',
] as const;

const deriveBiometricWrapKey = async (
  secret: Uint8Array,
  hkdfSalt: Uint8Array,
): Promise<CryptoKey> => {
  const baseKey = await crypto.subtle.importKey('raw', new Uint8Array(secret), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(hkdfSalt),
      info: new Uint8Array(utf8ToBytes(WRAP_KEY_HKDF_INFO)),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
};

const isValidWrapRecord = (record: unknown): record is BiometricWrapRecord => {
  if (!isJsonObject(record)) return false;
  return (
    Object.keys(record).length === WRAP_RECORD_KEYS.length &&
    Object.keys(record).every((key) => WRAP_RECORD_KEYS.some((expected) => expected === key)) &&
    record.version === BIOMETRIC_WRAP_VERSION &&
    typeof record.hkdfSalt === 'string' &&
    /^[0-9a-f]{32}$/.test(record.hkdfSalt) &&
    typeof record.iv === 'string' &&
    /^[0-9a-f]{24}$/.test(record.iv) &&
    typeof record.wrappedKey === 'string' &&
    record.wrappedKey.length > 0 &&
    record.wrappedKey.length % 2 === 0 &&
    /^[0-9a-f]+$/.test(record.wrappedKey) &&
    typeof record.pubkey === 'string' &&
    /^[0-9a-f]{66}$/.test(record.pubkey) &&
    typeof record.materialHash === 'string' &&
    /^[0-9a-f]{64}$/.test(record.materialHash) &&
    typeof record.createdAt === 'number' &&
    Number.isSafeInteger(record.createdAt) &&
    record.createdAt >= 0
  );
};

const readWrapRecord = (): BiometricWrapRecord | null => {
  const raw = localStorage.getItem(WRAP_RECORD_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidWrapRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const biometricWrapRecordsEqual = (
  left: BiometricWrapRecord,
  right: BiometricWrapRecord,
): boolean =>
  left.version === right.version &&
  left.hkdfSalt === right.hkdfSalt &&
  left.iv === right.iv &&
  left.wrappedKey === right.wrappedKey &&
  left.pubkey === right.pubkey &&
  left.materialHash === right.materialHash &&
  left.createdAt === right.createdAt;

// sync on purpose (same convention as hasPasskeySlots): the unlock form and
// the security page ask this during render/setup
export const isBiometricUnlockEnrolled = (): boolean => readWrapRecord() !== null;

export const biometricUnlockAvailable = async (): Promise<boolean> => {
  if (!isNative() || !isBiometricUnlockEnrolled()) return false;
  try {
    return (await BiometricAuth.checkBiometry()).isAvailable;
  } catch {
    return false;
  }
};

// the shared prompt options: weak biometry + device credential fallback, so
// any screen lock the holder already uses qualifies (see header)
const authenticate = (reason: string): Promise<void> =>
  BiometricAuth.authenticate({
    reason,
    cancelTitle: 'Cancel',
    allowDeviceCredential: true,
    androidTitle: 'sattle',
    androidSubtitle: reason,
    androidBiometryStrength: AndroidBiometryStrength.weak,
  });

// a cancelled prompt must surface as an ordinary failure message, not a
// crash-shaped error - normalize to a plain Error with holder-facing text
const authenticateOrThrow = async (reason: string): Promise<void> => {
  try {
    await authenticate(reason);
  } catch (err) {
    if (err instanceof BiometryError && err.code === BiometryErrorType.userCancel) {
      throw new Error('Biometric prompt was cancelled.', { cause: err });
    }
    throw err;
  }
};

export const enableBiometricUnlock = async (
  material: WalletMaterialV2,
): Promise<void> => {
  if (!isNative()) throw new Error('Biometric unlock is only available in the native app.');
  const serialized = serializeWalletMaterial(material);
  const canonicalMaterial = parseWalletMaterial(serialized);
  if (canonicalMaterial === null) throw new Error('Biometric wallet material is invalid.');
  const ownerId = walletMaterialOwnerId(canonicalMaterial);
  if (savedWalletMaterialOwnerId() !== ownerId) {
    throw new Error('Biometric enrollment requires the proven saved wallet owner.');
  }
  // exact-material commitment (same check as passkey slots): the enrolled
  // bytes must equal the canonical saved material, not just share its owner
  const materialHash = savedWalletMaterialHash();
  const plaintext = getPlainWalletMaterial();
  if (
    materialHash === null ||
    walletMaterialHash(canonicalMaterial) !== materialHash ||
    (plaintext !== null && serializeWalletMaterial(plaintext) !== serialized)
  ) {
    throw new Error('Biometric enrollment requires the exact saved wallet material.');
  }
  const biometry = await BiometricAuth.checkBiometry();
  if (!biometry.isAvailable) {
    throw new Error(biometry.reason || 'No biometric unlock is set up on this device.');
  }
  // prove presence before storing anything under the biometric gate
  await authenticateOrThrow('Set up biometric unlock for your wallet');
  // the prompt yields time: re-verify the commitment before writing anything
  if (savedWalletMaterialOwnerId() !== ownerId || savedWalletMaterialHash() !== materialHash) {
    throw new Error('Saved wallet material changed during biometric enrollment.');
  }
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const hkdfSalt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapKey = await deriveBiometricWrapKey(secret, hkdfSalt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      wrapKey,
      new Uint8Array(utf8ToBytes(serialized)),
    ),
  );
  // secure storage first: if it fails, no record is written and the wallet
  // simply stays unenrolled instead of carrying an unwrap-able-nothing
  await SecureStorage.set(SECURE_SECRET_KEY, bytesToHex(secret));
  const record: BiometricWrapRecord = {
    version: BIOMETRIC_WRAP_VERSION,
    hkdfSalt: bytesToHex(hkdfSalt),
    iv: bytesToHex(iv),
    wrappedKey: bytesToHex(ciphertext),
    pubkey: ownerId,
    materialHash,
    createdAt: Date.now(),
  };
  localStorage.setItem(WRAP_RECORD_STORAGE_KEY, JSON.stringify(record));
};

export const unlockWalletMaterialWithBiometrics = async (): Promise<WalletMaterialV2> => {
  const record = readWrapRecord();
  if (!isNative() || !record) {
    throw new Error('Biometric unlock is not set up on this device.');
  }
  const ownerId = savedWalletMaterialOwnerId();
  if (ownerId === null || ownerId !== record.pubkey) {
    throw new Error(
      'Biometric unlock belongs to a different wallet - set it up again in Settings > Security.',
    );
  }
  // the stored commitment must match the canonical saved material, or the
  // wrap is stale (same-owner cash-root replacement) and must not unlock
  const materialHash = savedWalletMaterialHash();
  if (materialHash === null || record.materialHash !== materialHash) {
    throw new Error(
      'Biometric unlock belongs to different wallet material - set it up again in Settings > Security.',
    );
  }
  await authenticateOrThrow('Unlock your sattle wallet');
  // the prompt yields time: re-read the record and the saved commitment
  // before any decrypted plaintext can reach the caller
  const currentRecord = readWrapRecord();
  if (currentRecord === null || !biometricWrapRecordsEqual(record, currentRecord)) {
    throw new Error('The biometric wrap changed during the unlock ceremony.');
  }
  if (savedWalletMaterialOwnerId() !== ownerId || savedWalletMaterialHash() !== materialHash) {
    throw new Error('Saved wallet material changed during the unlock ceremony.');
  }
  const secretHex = await SecureStorage.get(SECURE_SECRET_KEY);
  if (typeof secretHex !== 'string' || !/^[0-9a-f]{64}$/i.test(secretHex)) {
    throw new Error('Biometric unlock data is missing - set it up again in Settings > Security.');
  }
  const wrapKey = await deriveBiometricWrapKey(hexToBytes(secretHex), hexToBytes(record.hkdfSalt));
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(hexToBytes(record.iv)) },
    wrapKey,
    new Uint8Array(hexToBytes(record.wrappedKey)),
  );
  const material = parseWalletMaterial(new TextDecoder().decode(plaintext));
  if (
    material === null ||
    savedWalletMaterialOwnerId() !== ownerId ||
    walletMaterialOwnerId(material) !== ownerId
  ) {
    throw new Error(
      'Biometric unlock belongs to a different wallet - set it up again in Settings > Security.',
    );
  }
  // the decrypted material itself must carry the committed cash root
  if (savedWalletMaterialHash() !== materialHash || walletMaterialHash(material) !== materialHash) {
    throw new Error(
      'Biometric unlock belongs to different wallet material - set it up again in Settings > Security.',
    );
  }
  return material;
};

// Native deletion goes first so a failure leaves the complete enrollment
// available for the locked lifecycle to retry safely.
export const disableBiometricUnlock = async (): Promise<void> => {
  if (isNative()) {
    await SecureStorage.remove(SECURE_SECRET_KEY);
  }
  localStorage.removeItem(WRAP_RECORD_STORAGE_KEY);
};
