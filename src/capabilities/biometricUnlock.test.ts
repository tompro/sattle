import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deriveWalletMaterial,
  serializeWalletMaterial,
  walletMaterialHash,
  type WalletMaterialV2,
} from '@/lnurlcash/keys';
import { walletMaterialOwnerId } from '@/lnurlcash/storage/storedSecret';
import { saveWalletMaterial } from '@/lnurlcash/walletMaterialStorage';
import { parseJsonObject, stubLocalStorage } from '@/lnurlcash/test-utils';

const pluginMocks = vi.hoisted(() => ({
  authenticate: vi.fn<() => Promise<void>>(),
  checkBiometry: vi.fn<() => Promise<{ isAvailable: boolean; reason?: string }>>(),
  secureGet: vi.fn<(key: string) => Promise<string | null>>(),
  secureRemove: vi.fn<(key: string) => Promise<void>>(),
  secureSet: vi.fn<(key: string, value: string) => Promise<void>>(),
  secureValues: new Map<string, string>(),
}));

vi.mock('@aparajita/capacitor-biometric-auth', () => ({
  AndroidBiometryStrength: { weak: 'weak' },
  BiometricAuth: {
    authenticate: pluginMocks.authenticate,
    checkBiometry: pluginMocks.checkBiometry,
  },
  BiometryError: class BiometryError extends Error {},
  BiometryErrorType: { userCancel: 'userCancel' },
}));

vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: {
    get: pluginMocks.secureGet,
    remove: pluginMocks.secureRemove,
    set: pluginMocks.secureSet,
  },
}));

vi.mock('./platform', () => ({ isNative: () => true }));

import {
  disableBiometricUnlock,
  enableBiometricUnlock,
  unlockWalletMaterialWithBiometrics,
} from './biometricUnlock';

const SEED =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER_SEED = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const MATERIAL = deriveWalletMaterial(SEED);
const OTHER_MATERIAL = deriveWalletMaterial(OTHER_SEED);
// same linking key (same owner) as MATERIAL, but a different, VALID cash root
const ALTERED_ROOT_MATERIAL: WalletMaterialV2 = {
  ...MATERIAL,
  cashRootHex: OTHER_MATERIAL.cashRootHex,
};
const WRAP_SECRET = new Uint8Array(32).fill(3);
const WRAP_RECORD_KEY = 'sattle_biometric_wrap';
const SECURE_SECRET_KEY = 'sattle-biometric-wrap-secret';
const MATERIAL_STORAGE_KEY = 'sattle_wallet_material_v2';
const WRAP_KEY_HKDF_INFO = utf8ToBytes('sattle-biometric-wrap-v2');

const persistedState = () => ({
  legacyKey: localStorage.getItem('sattle_linking_key'),
  legacyNwc: localStorage.getItem('sattle_nwc_connections'),
  legacyPasskeys: localStorage.getItem('sattle_passkey_slots'),
  legacyTrust: localStorage.getItem('sattle_trusted_mints'),
  material: localStorage.getItem(MATERIAL_STORAGE_KEY),
  secureSecret: pluginMocks.secureValues.get(SECURE_SECRET_KEY) ?? null,
  wrap: localStorage.getItem(WRAP_RECORD_KEY),
});

const deriveFixtureWrapKey = async (
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
      info: new Uint8Array(WRAP_KEY_HKDF_INFO),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
};

const storePayload = async (
  plaintext: Uint8Array,
  pubkey: string,
  materialHash: string,
  secret = WRAP_SECRET,
): Promise<void> => {
  const hkdfSalt = new Uint8Array(16).fill(4);
  const iv = new Uint8Array(12).fill(5);
  const wrapKey = await deriveFixtureWrapKey(secret, hkdfSalt);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, new Uint8Array(plaintext)),
  );
  localStorage.setItem(
    WRAP_RECORD_KEY,
    JSON.stringify({
      version: 2,
      hkdfSalt: bytesToHex(hkdfSalt),
      iv: bytesToHex(iv),
      wrappedKey: bytesToHex(ciphertext),
      pubkey,
      materialHash,
      createdAt: 1,
    }),
  );
  pluginMocks.secureValues.set(SECURE_SECRET_KEY, bytesToHex(secret));
};

const storeMaterialPayload = async (
  material: WalletMaterialV2,
  pubkey = walletMaterialOwnerId(material),
  secret = WRAP_SECRET,
  materialHash = walletMaterialHash(material),
): Promise<void> =>
  storePayload(utf8ToBytes(serializeWalletMaterial(material)), pubkey, materialHash, secret);

beforeEach(() => {
  vi.clearAllMocks();
  stubLocalStorage();
  pluginMocks.secureValues.clear();
  pluginMocks.authenticate.mockResolvedValue();
  pluginMocks.checkBiometry.mockResolvedValue({ isAvailable: true });
  pluginMocks.secureGet.mockImplementation((key) =>
    Promise.resolve(pluginMocks.secureValues.get(key) ?? null),
  );
  pluginMocks.secureSet.mockImplementation((key, value) => {
    pluginMocks.secureValues.set(key, value);
    return Promise.resolve();
  });
  pluginMocks.secureRemove.mockImplementation((key) => {
    pluginMocks.secureValues.delete(key);
    return Promise.resolve();
  });
});

describe('biometric wallet material', () => {
  it('rejects foreign enrollment before writing either biometric store', async () => {
    // Given one proven saved owner and complete material for another owner
    await saveWalletMaterial(MATERIAL);
    const before = persistedState();

    // When enrollment is attempted with the foreign material
    const attempt = enableBiometricUnlock(OTHER_MATERIAL);

    // Then ownership fails before native or local persistence changes
    await expect(attempt).rejects.toThrow('proven saved wallet owner');
    expect(persistedState()).toEqual(before);
    expect(pluginMocks.secureSet).not.toHaveBeenCalled();
  });

  it('does not create a local wrap when secure-secret persistence fails', async () => {
    // Given valid material and a rejecting native secure store
    await saveWalletMaterial(MATERIAL);
    const before = persistedState();
    pluginMocks.secureSet.mockRejectedValueOnce(new Error('secure write failed'));

    // When enrollment reaches native secret persistence
    const attempt = enableBiometricUnlock(MATERIAL);

    // Then failure is reported without a misleading local enrollment record
    await expect(attempt).rejects.toThrow('secure write failed');
    expect(persistedState()).toEqual(before);
  });

  it('round-trips both key parts when enrollment belongs to the saved owner', async () => {
    // Given complete canonical material persisted for its proven owner
    await saveWalletMaterial(MATERIAL);

    // When the capability enrolls and unlocks it through the native adapter
    await enableBiometricUnlock(MATERIAL);
    const beforeUnlock = persistedState();
    const unlocked = await unlockWalletMaterialWithBiometrics();

    // Then both key parts return together and unlock does not rewrite persistence
    expect(unlocked).toEqual(MATERIAL);
    expect(persistedState()).toEqual(beforeUnlock);
  });

  it.each([
    ['malformed JSON', utf8ToBytes('{')],
    ['legacy key-only payload', new Uint8Array(32).fill(7)],
    [
      'altered root',
      utf8ToBytes(
        JSON.stringify({
          ...MATERIAL,
          cashRootHex: '00'.repeat(64),
        }),
      ),
    ],
  ])('returns no material for an authenticated %s and preserves state', async (_label, payload) => {
    // Given an authenticated non-canonical payload bound to the saved owner
    await saveWalletMaterial(MATERIAL);
    await storePayload(payload, walletMaterialOwnerId(MATERIAL), walletMaterialHash(MATERIAL));
    const before = persistedState();

    // When biometric unlock decrypts the payload
    const attempt = unlockWalletMaterialWithBiometrics();

    // Then neither key part crosses the boundary and persistence is byte-identical
    await expect(attempt).rejects.toThrow();
    expect(persistedState()).toEqual(before);
  });

  it('returns no material for a wrong secure secret and preserves state', async () => {
    // Given a valid wrap whose secure secret has been replaced
    await saveWalletMaterial(MATERIAL);
    await storeMaterialPayload(MATERIAL);
    pluginMocks.secureValues.set(SECURE_SECRET_KEY, '09'.repeat(32));
    const before = persistedState();

    // When biometric unlock authenticates with the wrong wrapping secret
    const attempt = unlockWalletMaterialWithBiometrics();

    // Then authenticated decryption fails without changing either store
    await expect(attempt).rejects.toThrow();
    expect(persistedState()).toEqual(before);
  });

  it('returns no material for altered ciphertext and preserves state', async () => {
    // Given a valid wrap with one ciphertext nibble altered
    await saveWalletMaterial(MATERIAL);
    await storeMaterialPayload(MATERIAL);
    const record = parseJsonObject(localStorage.getItem(WRAP_RECORD_KEY) ?? '{}');
    const wrappedKey = record.wrappedKey;
    if (typeof wrappedKey !== 'string') throw new Error('fixture wrap is missing ciphertext');
    localStorage.setItem(
      WRAP_RECORD_KEY,
      JSON.stringify({
        ...record,
        wrappedKey: `${wrappedKey.startsWith('0') ? '1' : '0'}${wrappedKey.slice(1)}`,
      }),
    );
    const before = persistedState();

    // When biometric unlock verifies the AES-GCM tag
    const attempt = unlockWalletMaterialWithBiometrics();

    // Then neither key part returns and persistence remains untouched
    await expect(attempt).rejects.toThrow();
    expect(persistedState()).toEqual(before);
  });

  it('rejects a stale wrap after saved-owner replacement without rewriting it', async () => {
    // Given material wrapped for one owner and saved material replaced by another
    await saveWalletMaterial(MATERIAL);
    await storeMaterialPayload(MATERIAL);
    await saveWalletMaterial(OTHER_MATERIAL);
    const before = persistedState();

    // When the stale biometric record is used
    const attempt = unlockWalletMaterialWithBiometrics();

    // Then no old material returns and both stores remain byte-identical
    await expect(attempt).rejects.toThrow('different wallet');
    expect(persistedState()).toEqual(before);
  });

  it('rejects authenticated material owned by another linking key', async () => {
    // Given the saved owner and wrap claim owner A but authenticated material owner B
    await saveWalletMaterial(MATERIAL);
    localStorage.setItem('sattle_linking_key', 'legacy-key-residue');
    localStorage.setItem('sattle_nwc_connections', 'legacy-nwc-residue');
    localStorage.setItem('sattle_passkey_slots', 'legacy-passkey-residue');
    localStorage.setItem('sattle_trusted_mints', 'legacy-trust-residue');
    await storeMaterialPayload(
      OTHER_MATERIAL,
      walletMaterialOwnerId(MATERIAL),
      WRAP_SECRET,
      walletMaterialHash(MATERIAL),
    );
    const before = persistedState();

    // When biometric unlock checks the decrypted linking-key owner
    const attempt = unlockWalletMaterialWithBiometrics();

    // Then neither foreign key part returns and persistence is unchanged
    await expect(attempt).rejects.toThrow('different wallet');
    expect(persistedState()).toEqual(before);
  });
});

describe('biometric exact-material commitment', () => {
  it('rejects same-owner altered-root enrollment before writing either biometric store', async () => {
    // Given one proven saved owner and well-formed material with only the cash root swapped
    await saveWalletMaterial(MATERIAL);
    const before = persistedState();

    // When enrollment is attempted with the same-owner altered-root material
    const attempt = enableBiometricUnlock(ALTERED_ROOT_MATERIAL);

    // Then the exact-material commitment fails before native or local persistence changes
    await expect(attempt).rejects.toThrow('saved wallet material');
    expect(persistedState()).toEqual(before);
    expect(pluginMocks.secureSet).not.toHaveBeenCalled();
  });

  it('rejects same-owner altered-root enrollment against encrypted saved material', async () => {
    // Given the saved material envelope is password-encrypted (no plaintext available)
    await saveWalletMaterial(MATERIAL, 'password');
    const before = persistedState();

    // When enrollment is attempted with the same-owner altered-root material
    const attempt = enableBiometricUnlock(ALTERED_ROOT_MATERIAL);

    // Then the hash commitment alone rejects it before either store changes
    await expect(attempt).rejects.toThrow('saved wallet material');
    expect(persistedState()).toEqual(before);
    expect(pluginMocks.secureSet).not.toHaveBeenCalled();
  });

  it('rejects enrollment when same-owner saved material changes during the prompt', async () => {
    // Given valid enrollment input and a prompt-time swap of only the saved cash root
    await saveWalletMaterial(MATERIAL);
    pluginMocks.authenticate.mockImplementationOnce(async () => {
      await saveWalletMaterial(ALTERED_ROOT_MATERIAL);
    });

    // When enrollment runs the biometric prompt
    const attempt = enableBiometricUnlock(MATERIAL);

    // Then the post-prompt commitment recheck fails and no biometric store is written
    await expect(attempt).rejects.toThrow('changed');
    expect(localStorage.getItem(WRAP_RECORD_KEY)).toBeNull();
    expect(pluginMocks.secureValues.has(SECURE_SECRET_KEY)).toBe(false);
    expect(pluginMocks.secureSet).not.toHaveBeenCalled();
  });

  it('rejects an authenticated well-formed same-owner altered-root payload', async () => {
    // Given an authenticated wrap that claims the saved commitment but whose
    // decrypted material swaps only the cash root
    await saveWalletMaterial(MATERIAL);
    await storeMaterialPayload(
      ALTERED_ROOT_MATERIAL,
      walletMaterialOwnerId(ALTERED_ROOT_MATERIAL),
      WRAP_SECRET,
      walletMaterialHash(MATERIAL),
    );
    const before = persistedState();

    // When biometric unlock decrypts the well-formed same-owner payload
    const attempt = unlockWalletMaterialWithBiometrics();

    // Then the material commitment rejects it and both stores stay byte-identical
    await expect(attempt).rejects.toThrow('wallet material');
    expect(persistedState()).toEqual(before);
  });

  it('rejects a wrap whose own commitment differs from the saved material before prompting', async () => {
    // Given an authenticated wrap committed to same-owner altered-root material
    await saveWalletMaterial(MATERIAL);
    await storeMaterialPayload(ALTERED_ROOT_MATERIAL);
    const before = persistedState();

    // When biometric unlock inspects the record commitment
    const attempt = unlockWalletMaterialWithBiometrics();

    // Then it rejects before any prompt and both stores stay byte-identical
    await expect(attempt).rejects.toThrow('wallet material');
    expect(pluginMocks.authenticate).not.toHaveBeenCalled();
    expect(persistedState()).toEqual(before);
  });

  it('rejects a stale wrap after same-owner saved material replacement', async () => {
    // Given an enrolled wrap and a later saved-material swap of only the cash root
    await saveWalletMaterial(MATERIAL);
    await enableBiometricUnlock(MATERIAL);
    await saveWalletMaterial(ALTERED_ROOT_MATERIAL);
    const before = persistedState();

    // When the now-stale biometric wrap is used
    const attempt = unlockWalletMaterialWithBiometrics();

    // Then the stale commitment rejects and both stores stay byte-identical
    await expect(attempt).rejects.toThrow('wallet material');
    expect(persistedState()).toEqual(before);
  });

  it('rejects unlock when same-owner saved material changes during the prompt', async () => {
    // Given an enrolled wrap and a prompt-time swap of only the saved cash root
    await saveWalletMaterial(MATERIAL);
    await enableBiometricUnlock(MATERIAL);
    let swapped: ReturnType<typeof persistedState> | null = null;
    pluginMocks.authenticate.mockImplementationOnce(async () => {
      await saveWalletMaterial(ALTERED_ROOT_MATERIAL);
      swapped = persistedState();
    });

    // When biometric unlock runs the prompt
    const attempt = unlockWalletMaterialWithBiometrics();

    // Then the post-prompt commitment recheck rejects and the ceremony writes nothing
    await expect(attempt).rejects.toThrow('changed');
    expect(swapped).not.toBeNull();
    expect(persistedState()).toEqual(swapped);
  });

  it('rejects unlock when the wrap record is replaced during the prompt', async () => {
    // Given an enrolled wrap replaced mid-prompt by another valid same-owner record
    await saveWalletMaterial(MATERIAL);
    await enableBiometricUnlock(MATERIAL);
    let swapped: ReturnType<typeof persistedState> | null = null;
    pluginMocks.authenticate.mockImplementationOnce(async () => {
      const secret = pluginMocks.secureValues.get(SECURE_SECRET_KEY);
      if (typeof secret !== 'string') throw new Error('expected an enrolled secure secret');
      await storeMaterialPayload(MATERIAL, walletMaterialOwnerId(MATERIAL), hexToBytes(secret));
      swapped = persistedState();
    });

    // When biometric unlock runs the prompt
    const attempt = unlockWalletMaterialWithBiometrics();

    // Then the record recheck rejects and the ceremony writes nothing itself
    await expect(attempt).rejects.toThrow('changed');
    expect(swapped).not.toBeNull();
    expect(persistedState()).toEqual(swapped);
  });
});

describe('biometric deletion ordering', () => {
  it('keeps native and local state retryable when secure-secret deletion fails', async () => {
    // Given a complete enrolled biometric wrap
    await saveWalletMaterial(MATERIAL);
    await enableBiometricUnlock(MATERIAL);
    const before = persistedState();
    pluginMocks.secureRemove.mockRejectedValueOnce(new Error('native deletion failed'));

    // When native secure-secret deletion fails
    const attempt = disableBiometricUnlock();

    // Then failure is reported before either persisted part is removed
    await expect(attempt).rejects.toThrow('native deletion failed');
    expect(persistedState()).toEqual(before);
  });

  it('supports repeated delete interruption followed by a successful retry', async () => {
    // Given two interrupted deletion attempts for an enrolled wrap
    await saveWalletMaterial(MATERIAL);
    await enableBiometricUnlock(MATERIAL);
    const before = persistedState();
    pluginMocks.secureRemove.mockRejectedValueOnce(new Error('first interruption'));
    pluginMocks.secureRemove.mockRejectedValueOnce(new Error('second interruption'));

    // When deletion is retried until native removal succeeds
    await expect(disableBiometricUnlock()).rejects.toThrow('first interruption');
    expect(persistedState()).toEqual(before);
    await expect(disableBiometricUnlock()).rejects.toThrow('second interruption');
    expect(persistedState()).toEqual(before);
    await disableBiometricUnlock();

    // Then native state is gone before the local wrap is removed
    expect(pluginMocks.secureValues.has(SECURE_SECRET_KEY)).toBe(false);
    expect(localStorage.getItem(WRAP_RECORD_KEY)).toBeNull();
    expect(localStorage.getItem(MATERIAL_STORAGE_KEY)).toBe(before.material);
  });
});
