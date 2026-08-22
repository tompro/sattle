import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';

import { linkingPubKeyHex, savedKeyOwnerId } from '@/lnurlcash/keys';
import { wrapLinkingKeyWithPrf } from '@/lnurlcash/passkeys';
import { readPasskeySlots } from '@/lnurlcash/storage/passkeySlots';
import { parseJsonObject, stubLocalStorage } from '@/lnurlcash/test-utils';

const pluginMocks = vi.hoisted(() => ({
  authenticate: vi.fn<() => Promise<void>>(),
  secureGet: vi.fn<(key: string) => Promise<string | null>>(),
}));

vi.mock('@aparajita/capacitor-biometric-auth', () => ({
  AndroidBiometryStrength: { weak: 'weak' },
  BiometricAuth: { authenticate: pluginMocks.authenticate },
  BiometryError: class BiometryError extends Error {},
  BiometryErrorType: { userCancel: 'userCancel' },
}));

vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: { get: pluginMocks.secureGet },
}));

vi.mock('./platform', () => ({ isNative: () => true }));

import { unlockWithBiometrics } from './biometricUnlock';

const LINKING_KEY = new Uint8Array(32).fill(7);
const OTHER_LINKING_KEY = new Uint8Array(32).fill(9);
const WRAP_SECRET = new Uint8Array(32).fill(3);

beforeEach(() => {
  vi.clearAllMocks();
  stubLocalStorage();
  pluginMocks.authenticate.mockResolvedValue();
  pluginMocks.secureGet.mockResolvedValue(bytesToHex(WRAP_SECRET));
});

describe('biometric unlock owner proof', () => {
  it('cannot return a key or adopt legacy owner data when the stored pubkey is wrong', async () => {
    // Given an ownerless legacy wallet and credential residue plus a biometric wrap
    // whose claimed pubkey does not match the key it unwraps
    const legacyKey = { enc: false, value: bytesToHex(LINKING_KEY) };
    const legacySlot = {
      credentialId: '11'.repeat(16),
      hkdfSalt: '22'.repeat(16),
      iv: '33'.repeat(12),
      wrappedKey: '44'.repeat(48),
      createdAt: 1,
    };
    const legacyNwc = [
      {
        clientPubkey: '55'.repeat(32),
        relays: ['wss://relay.example'],
        budget: { maxMsat: 1000, periodMs: 60_000 },
        spent: { periodStart: 0, msat: 0 },
        createdAt: 1,
      },
    ];
    const legacyTrust = [
      {
        server: 'legacy.example',
        mintPubkey: '02' + 'aa'.repeat(32),
        addedAt: 1,
        locked: false,
      },
    ];
    localStorage.setItem('sattle_linking_key', JSON.stringify(legacyKey));
    localStorage.setItem('sattle_passkey_slots', JSON.stringify([legacySlot]));
    localStorage.setItem('sattle_nwc_connections', JSON.stringify(legacyNwc));
    localStorage.setItem('sattle_nwc_enabled', 'true');
    localStorage.setItem('sattle_trusted_mints', JSON.stringify(legacyTrust));
    const wrap = await wrapLinkingKeyWithPrf(WRAP_SECRET, LINKING_KEY);
    localStorage.setItem(
      'sattle_biometric_wrap',
      JSON.stringify({
        ...wrap,
        pubkey: linkingPubKeyHex(OTHER_LINKING_KEY),
        createdAt: 1,
      }),
    );
    const before = new Map([
      ['sattle_linking_key', localStorage.getItem('sattle_linking_key')],
      ['sattle_passkey_slots', localStorage.getItem('sattle_passkey_slots')],
      ['sattle_nwc_connections', localStorage.getItem('sattle_nwc_connections')],
      ['sattle_nwc_enabled', localStorage.getItem('sattle_nwc_enabled')],
      ['sattle_trusted_mints', localStorage.getItem('sattle_trusted_mints')],
    ]);

    // When biometric unwrap reaches the pubkey proof check
    const attempt = unlockWithBiometrics();

    // Then no key crosses the capability boundary and no legacy namespace is adopted
    await expect(attempt).rejects.toThrow('different wallet');
    expect(savedKeyOwnerId()).toBeNull();
    expect(readPasskeySlots()).toEqual([]);
    expect(parseJsonObject(localStorage.getItem('sattle_linking_key') ?? '{}')).toEqual(legacyKey);
    for (const [key, value] of before) expect(localStorage.getItem(key)).toBe(value);
  });
});
