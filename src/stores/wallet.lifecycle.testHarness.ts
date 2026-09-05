import { bytesToHex } from '@noble/hashes/utils.js';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, vi } from 'vitest';

import {
  deriveWalletMaterial,
  encryptSecretParts,
  linkingPubKeyHex,
  serializeWalletMaterial,
  walletMaterialHash,
} from '@/lnurlcash/keys';
import type { WalletMaterialV2 } from '@/lnurlcash/keys';
import type * as NwcExports from '@/lnurlcash/nwc';
import type * as NostrBackupExports from '@/lnurlcash/nostrBackup';
import type * as PasskeysExports from '@/lnurlcash/passkeys';
import { WALLET_MATERIAL_STORAGE_KEY } from '@/lnurlcash/storage/walletOwnerEvents';
import { stubLocalStorage } from '@/lnurlcash/test-utils';
import { lifecycleMocks } from './wallet.lifecycle.testMocks';

export { lifecycleMocks as mocks } from './wallet.lifecycle.testMocks';

vi.mock('@/capabilities/biometricUnlock', async () => {
  const { lifecycleMocks } = await import('./wallet.lifecycle.testMocks');
  return {
    disableBiometricUnlock: lifecycleMocks.disableBiometricUnlock,
    unlockWalletMaterialWithBiometrics: lifecycleMocks.unlockWalletMaterialWithBiometrics,
  };
});

vi.mock('@/lnurlcash/passkeys', async (importOriginal) => {
  const { lifecycleMocks } = await import('./wallet.lifecycle.testMocks');
  const actual = await importOriginal<typeof PasskeysExports>();
  return {
    ...actual,
    unlockWalletMaterialWithPasskey: lifecycleMocks.unlockWalletMaterialWithPasskey,
  };
});

vi.mock('@/lnurlcash/nwc', async (importOriginal) => {
  const { lifecycleMocks } = await import('./wallet.lifecycle.testMocks');
  const actual = await importOriginal<typeof NwcExports>();
  return { ...actual, startService: lifecycleMocks.startService };
});

vi.mock('@/lnurlcash/nostrBackup', async (importOriginal) => {
  const { lifecycleMocks } = await import('./wallet.lifecycle.testMocks');
  const actual = await importOriginal<typeof NostrBackupExports>();
  return { ...actual, restoreFromNostr: lifecycleMocks.restoreFromNostr };
});

export const LINKING_KEY = new Uint8Array(32).fill(7);
export const OTHER_LINKING_KEY = new Uint8Array(32).fill(9);
export const MATERIAL: WalletMaterialV2 = {
  ...deriveWalletMaterial(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  ),
  linkingKeyHex: bytesToHex(LINKING_KEY),
};
export const OTHER_MATERIAL: WalletMaterialV2 = {
  ...MATERIAL,
  linkingKeyHex: bytesToHex(OTHER_LINKING_KEY),
};
export const OWNER_ID = linkingPubKeyHex(LINKING_KEY);
export const OTHER_OWNER_ID = linkingPubKeyHex(OTHER_LINKING_KEY);
export const PASSWORD = 'correct horse battery staple';
export const MINT_KEY = '02' + 'aa'.repeat(32);

export const WALLET_MATERIAL_KEY = WALLET_MATERIAL_STORAGE_KEY;
export const LEGACY_LINKING_KEY = 'sattle_linking_key';
// the frozen pre-v2 bearer namespace: current storage never writes it, so
// its presence means an alpha install
export const LEGACY_BEARERS_KEY = 'sattle_bearers';

export const encryptedWalletMaterialRecord = async (
  material: WalletMaterialV2 = MATERIAL,
  password: string = PASSWORD,
) => {
  const parts = await encryptSecretParts(serializeWalletMaterial(material), password);
  return { enc: true as const, ...parts, materialHash: walletMaterialHash(material) };
};

// a v2 install whose owner marker is already proven (the steady state after
// any successful unlock)
export const installEncryptedWalletMaterial = async (): Promise<void> => {
  const record = await encryptedWalletMaterialRecord();
  localStorage.setItem(
    WALLET_MATERIAL_KEY,
    JSON.stringify({ ...record, ownerId: OWNER_ID, version: 2 }),
  );
};

// a v2 install whose owner marker was stripped on restore - usable but not
// yet proven, the state a backup/relay restore leaves behind
export const installOwnerlessEncryptedWalletMaterial = async (): Promise<void> => {
  localStorage.setItem(
    WALLET_MATERIAL_KEY,
    JSON.stringify(await encryptedWalletMaterialRecord()),
  );
};

// the pre-v2 record shape a backup file can still carry - the lifecycle must
// never activate it, only clear it
export const encryptedLinkingKeyRecord = async () => {
  const parts = await encryptSecretParts(bytesToHex(LINKING_KEY), PASSWORD);
  return { enc: true as const, ...parts };
};

// unsupported alpha state: the linking-key-only record and the legacy bearer
// namespace, never written by the v2 lifecycle
export const installLegacyWalletState = (): void => {
  localStorage.setItem(
    LEGACY_LINKING_KEY,
    JSON.stringify({ enc: false, value: bytesToHex(LINKING_KEY), ownerId: OWNER_ID, version: 1 }),
  );
  localStorage.setItem(LEGACY_BEARERS_KEY, JSON.stringify([]));
};

type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

export const deferred = (): Deferred => {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
};

type LockRequest = {
  readonly callback: () => unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
};

// a navigator.locks stand-in whose requests queue up until the test releases
// them one at a time - the deferral hook for mid-activation interruptions.
// A callback failure rejects the lock promise (the real LockManager settles
// the caller's promise with the callback outcome)
export const deferredLocks = () => {
  const requests: LockRequest[] = [];
  return {
    requests,
    locks: {
      request: (_name: string, callback: () => unknown): Promise<unknown> =>
        new Promise((resolve, reject) => {
          requests.push({ callback, resolve, reject });
        }),
    },
    releaseNext: async (): Promise<void> => {
      const request = requests.shift();
      if (!request) throw new Error('Expected a queued lock request.');
      try {
        request.resolve(await request.callback());
      } catch (error) {
        request.reject(error);
      }
    },
  };
};

export const installLegacyOwnerlessResidue = (): void => {
  localStorage.setItem(
    'sattle_passkey_slots',
    JSON.stringify([
      {
        credentialId: '11'.repeat(16),
        hkdfSalt: '22'.repeat(16),
        iv: '33'.repeat(12),
        materialHash: walletMaterialHash(MATERIAL),
        wrappedMaterial: '44'.repeat(48),
        createdAt: 1,
      },
    ]),
  );
  localStorage.setItem(
    'sattle_nwc_connections',
    JSON.stringify([
      {
        clientPubkey: '55'.repeat(32),
        relays: ['wss://relay.example'],
        budget: { maxMsat: 1000, periodMs: 60_000 },
        spent: { periodStart: 0, msat: 0 },
        createdAt: 1,
      },
    ]),
  );
  localStorage.setItem('sattle_nwc_enabled', 'true');
  localStorage.setItem(
    'sattle_trusted_mints',
    JSON.stringify([
      {
        server: 'legacy.example',
        mintPubkey: MINT_KEY,
        addedAt: 1,
        locked: false,
      },
    ]),
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  stubLocalStorage();
  setActivePinia(createPinia());
  lifecycleMocks.disableBiometricUnlock.mockResolvedValue();
  lifecycleMocks.unlockWalletMaterialWithBiometrics.mockRejectedValue(
    new Error('Biometric unlock is not set up on this device.'),
  );
  lifecycleMocks.unlockWalletMaterialWithPasskey.mockRejectedValue(
    new Error('No passkeys registered on this device.'),
  );
  lifecycleMocks.restoreFromNostr.mockResolvedValue({
    added: 0,
    skipped: 0,
    linkingKeyRestored: false,
    linkingKeySkipped: false,
    trustedMintsAdded: 0,
    settingsRestored: false,
    found: [],
  });
  lifecycleMocks.startService.mockResolvedValue({ stop: vi.fn().mockResolvedValue(undefined) });
});
