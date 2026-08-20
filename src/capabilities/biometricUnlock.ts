// Native biometric unlock: a THIRD wrap of the same linking key, alongside
// the password wrap (keys.ts) and the passkey slots (passkeys.ts).
//
// Why native: Android WebView has no usable WebAuthn platform authenticator
// for this app (passkeys need Play Services / Digital Asset Links wiring we
// cannot rely on), so the biometric path on native is a device-credential
// prompt instead of a passkey ceremony.
//
// Design (mirrors the passkey-slot construction, reusing its wrap
// primitives verbatim): on enrollment a random 32-byte wrap secret is
// generated, the linking key is AES-GCM-wrapped under an HKDF of that
// secret (wrapLinkingKeyWithPrf - the "PRF output" parameter is just 32
// bytes of IKM), and only the SECRET goes into biometric-gated secure
// storage (Android Keystore-backed AES-GCM via
// @aparajita/capacitor-secure-storage). The wrapped blob stays in
// localStorage as a record shaped like a passkey slot, plus the linking
// pubkey as an identity check: restoring a DIFFERENT seed leaves a stale
// wrap behind, and unlocking with it must fail loudly (never activate the
// old wallet silently), so unlock verifies the unwrapped key against the
// recorded pubkey and tells the holder to re-enroll.
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
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

import { linkingPubKeyHex } from '@/lnurlcash/keys';
import type { PasskeyWrap } from '@/lnurlcash/passkeys';
import { unwrapLinkingKeyWithPrf, wrapLinkingKeyWithPrf } from '@/lnurlcash/passkeys';

import { isNative } from './platform';

type BiometricWrapRecord = PasskeyWrap & {
  pubkey: string; // linking pubkey the wrap belongs to - detects stale wraps
  createdAt: number;
};

// the wrapped blob is useless without the secure-storage secret, so (like
// the passkey slots) this record sits in plain localStorage
const WRAP_RECORD_STORAGE_KEY = 'sattle_biometric_wrap';
const SECURE_SECRET_KEY = 'sattle-biometric-wrap-secret';

const isValidWrapRecord = (record: unknown): record is BiometricWrapRecord => {
  if (typeof record !== 'object' || record === null) return false;
  const r = record as Record<string, unknown>;
  return (
    typeof r.hkdfSalt === 'string' &&
    /^[0-9a-f]{32}$/i.test(r.hkdfSalt) &&
    typeof r.iv === 'string' &&
    /^[0-9a-f]{24}$/i.test(r.iv) &&
    typeof r.wrappedKey === 'string' &&
    r.wrappedKey.length > 0 &&
    r.wrappedKey.length % 2 === 0 &&
    /^[0-9a-f]+$/i.test(r.wrappedKey) &&
    typeof r.pubkey === 'string' &&
    /^[0-9a-f]{66}$/i.test(r.pubkey) &&
    typeof r.createdAt === 'number'
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

export const enableBiometricUnlock = async (linkingKey: Uint8Array): Promise<void> => {
  if (!isNative()) throw new Error('Biometric unlock is only available in the native app.');
  const biometry = await BiometricAuth.checkBiometry();
  if (!biometry.isAvailable) {
    throw new Error(biometry.reason || 'No biometric unlock is set up on this device.');
  }
  // prove presence before storing anything under the biometric gate
  await authenticateOrThrow('Set up biometric unlock for your wallet');
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const wrap = await wrapLinkingKeyWithPrf(secret, linkingKey);
  // secure storage first: if it fails, no record is written and the wallet
  // simply stays unenrolled instead of carrying an unwrap-able-nothing
  await SecureStorage.set(SECURE_SECRET_KEY, bytesToHex(secret));
  const record: BiometricWrapRecord = {
    ...wrap,
    pubkey: linkingPubKeyHex(linkingKey),
    createdAt: Date.now(),
  };
  localStorage.setItem(WRAP_RECORD_STORAGE_KEY, JSON.stringify(record));
};

export const unlockWithBiometrics = async (): Promise<Uint8Array> => {
  const record = readWrapRecord();
  if (!isNative() || !record) {
    throw new Error('Biometric unlock is not set up on this device.');
  }
  await authenticateOrThrow('Unlock your sattle wallet');
  const secretHex = await SecureStorage.get(SECURE_SECRET_KEY);
  if (typeof secretHex !== 'string' || !/^[0-9a-f]{64}$/i.test(secretHex)) {
    throw new Error('Biometric unlock data is missing - set it up again in Settings > Security.');
  }
  const linkingKey = await unwrapLinkingKeyWithPrf(hexToBytes(secretHex), record);
  if (linkingPubKeyHex(linkingKey) !== record.pubkey) {
    throw new Error(
      'Biometric unlock belongs to a different wallet - set it up again in Settings > Security.',
    );
  }
  return linkingKey;
};

// the localStorage record goes first and synchronously: even if the caller
// fire-and-forgets this (forgetWallet), a later unlock attempt can never
// reach the secure secret with a stale record
export const disableBiometricUnlock = async (): Promise<void> => {
  localStorage.removeItem(WRAP_RECORD_STORAGE_KEY);
  if (isNative()) {
    await SecureStorage.remove(SECURE_SECRET_KEY);
  }
};
