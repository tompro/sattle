import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, vi } from 'vitest';

import { encryptSecretParts, linkingPubKeyHex } from '@/lnurlcash/keys';
import type * as NwcExports from '@/lnurlcash/nwc';
import type * as NostrBackupExports from '@/lnurlcash/nostrBackup';
import { stubLocalStorage } from '@/lnurlcash/test-utils';
import { lifecycleMocks } from './wallet.lifecycle.testMocks';

export { lifecycleMocks as mocks } from './wallet.lifecycle.testMocks';

vi.mock('@/capabilities/biometricUnlock', async () => {
  const { lifecycleMocks } = await import('./wallet.lifecycle.testMocks');
  return {
    disableBiometricUnlock: lifecycleMocks.disableBiometricUnlock,
    unlockWithBiometrics: vi.fn(),
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
export const OWNER_ID = linkingPubKeyHex(LINKING_KEY);
export const OTHER_OWNER_ID = linkingPubKeyHex(OTHER_LINKING_KEY);
export const PASSWORD = 'correct horse battery staple';
export const MINT_KEY = '02' + 'aa'.repeat(32);

export const encryptedLinkingKeyRecord = async () => {
  const parts = await encryptSecretParts(
    Array.from(LINKING_KEY, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    PASSWORD,
  );
  return { enc: true as const, ...parts };
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

export const installLegacyOwnerlessResidue = (): void => {
  localStorage.setItem(
    'sattle_passkey_slots',
    JSON.stringify([
      {
        credentialId: '11'.repeat(16),
        hkdfSalt: '22'.repeat(16),
        iv: '33'.repeat(12),
        wrappedKey: '44'.repeat(48),
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

export const installLegacyEncryptedWallet = async (): Promise<void> => {
  localStorage.setItem('sattle_linking_key', JSON.stringify(await encryptedLinkingKeyRecord()));
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  stubLocalStorage();
  setActivePinia(createPinia());
  lifecycleMocks.disableBiometricUnlock.mockResolvedValue();
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
