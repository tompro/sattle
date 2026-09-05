import {
  deriveWalletMaterial,
  ensureSavedWalletMaterialOwner,
  isValidSeedPhrase,
  saveWalletMaterial,
  savedWalletMaterialExists,
  walletMaterialLinkingKey,
} from '@/lnurlcash/keys';
import type { WalletMaterialV2 } from '@/lnurlcash/keys';
import { disableBiometricUnlock } from '@/capabilities/biometricUnlock';
import { migrateLegacyPasskeySlots } from '@/lnurlcash/passkeys';
import { clearAllActivity, clearSettings } from '@/lnurlcash/storage';
import {
  clearPasskeySlotsForOwner,
  clearUnownedPasskeySlots,
  PASSKEY_SLOTS_STORAGE_KEY,
} from '@/lnurlcash/storage/passkeySlots';
import {
  clearNwcStorageForOwner,
  clearUnownedNwcStorage,
  migrateLegacyNwcStorage,
} from '@/lnurlcash/storage/nwcConnections';
import { withStorageLock } from '@/lnurlcash/storageLock';
import {
  LINKING_KEY_STORAGE_KEY,
  WALLET_MATERIAL_STORAGE_KEY,
} from '@/lnurlcash/storage/walletOwnerEvents';
import { walletMaterialOwnerId } from '@/lnurlcash/storage/storedSecret';
import {
  migrateLegacyTrustedMints,
  removeTrustedMintsForOwner,
  resetTrustedMintsForReplacement,
} from '@/lnurlcash/trustedMints';

export type WalletTransitionQueue = {
  readonly run: <Result>(transition: () => Promise<Result>) => Promise<Result>;
};

type WalletTransitionQueueOptions = {
  readonly onStart: () => void;
  readonly onError: (error: unknown) => void;
};

export const createWalletTransitionQueue = (
  options: WalletTransitionQueueOptions,
): WalletTransitionQueue => {
  let tail: Promise<void> = Promise.resolve();
  return {
    run: <Result>(transition: () => Promise<Result>): Promise<Result> => {
      const execute = async (): Promise<Result> => {
        options.onStart();
        try {
          return await transition();
        } catch (error) {
          options.onError(error);
          throw error;
        }
      };
      const operation = tail.then(execute, execute);
      tail = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
  };
};

export class WalletLifecycleError extends Error {
  override readonly name = 'WalletLifecycleError';

  constructor(
    readonly transition: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : 'Unknown failure.';
    super(`Wallet ${transition} failed: ${detail}`, { cause });
  }
}

export const stopWalletNwcSession = async (): Promise<void> => {
  const { useNwcStore } = await import('./nwc');
  await useNwcStore().stop();
};

export const migrateProvenLegacyOwner = async (
  material: WalletMaterialV2,
  ownerWasMissing: boolean,
): Promise<void> => {
  ensureSavedWalletMaterialOwner(material);
  if (!ownerWasMissing) return;
  const linkingKey = walletMaterialLinkingKey(material);
  await migrateLegacyPasskeySlots(linkingKey);
  migrateLegacyNwcStorage(linkingKey);
  await migrateLegacyTrustedMints(linkingKey);
};

export const clearOwnerAuthorizations = async (
  ownerId: string,
  resetRegistry = false,
): Promise<void> => {
  await withStorageLock(PASSKEY_SLOTS_STORAGE_KEY, () => {
    clearPasskeySlotsForOwner(ownerId);
  });
  clearNwcStorageForOwner(ownerId);
  if (resetRegistry) await resetTrustedMintsForReplacement();
  else await removeTrustedMintsForOwner(ownerId);
};

export const clearUnownedAuthorizations = async (): Promise<void> => {
  await withStorageLock(PASSKEY_SLOTS_STORAGE_KEY, clearUnownedPasskeySlots);
  clearUnownedNwcStorage();
  await resetTrustedMintsForReplacement();
};

// ---- unsupported legacy (alpha) install reset ----

// Frozen namespaces the v2 lifecycle never writes: the linking-key-only
// record and the pre-funds-document bearer store. Their raw presence (even
// corrupt or unparseable) means this device holds an alpha install, which
// cannot be migrated - the cash root is unrecoverable from a linking key -
// so it is reset, never upgraded.
const LEGACY_BEARERS_STORAGE_KEY = 'sattle_bearers';
// current owner-bound namespaces that a full reset removes outright; the
// key strings are duplicated here because the reset deletes whole
// namespaces by name rather than going through owner-scoped APIs
const NWC_CONNECTIONS_STORAGE_KEY = 'sattle_nwc_connections';
const NWC_ENABLED_STORAGE_KEY = 'sattle_nwc_enabled';

export const hasUnsupportedLegacyWalletState = (): boolean =>
  !savedWalletMaterialExists() &&
  (localStorage.getItem(LINKING_KEY_STORAGE_KEY) !== null ||
    localStorage.getItem(LEGACY_BEARERS_STORAGE_KEY) !== null);

// Alpha reset. No migration: every namespace the alpha wallet could have
// touched is removed and the device returns to the uninstalled state. The
// native biometric secret is deleted FIRST (same ordering as forget): if
// that fails, nothing local has been wiped yet, so the next attempt retries
// the whole reset instead of leaving a half-wiped install. When a v2
// install is present instead, only stray legacy-key residue is removed - the
// live wallet (including its bearer store) is untouched.
export const resetUnsupportedLegacyWalletState = async (): Promise<void> => {
  if (savedWalletMaterialExists()) {
    localStorage.removeItem(LINKING_KEY_STORAGE_KEY);
    return;
  }
  if (!hasUnsupportedLegacyWalletState()) return;
  await disableBiometricUnlock();
  localStorage.removeItem(LINKING_KEY_STORAGE_KEY);
  localStorage.removeItem(LEGACY_BEARERS_STORAGE_KEY);
  localStorage.removeItem(WALLET_MATERIAL_STORAGE_KEY);
  localStorage.removeItem(PASSKEY_SLOTS_STORAGE_KEY);
  localStorage.removeItem(NWC_CONNECTIONS_STORAGE_KEY);
  localStorage.removeItem(NWC_ENABLED_STORAGE_KEY);
  clearAllActivity();
  clearSettings();
  await resetTrustedMintsForReplacement();
};

type SeedInstallerOptions = {
  readonly prepareInstallation: (ownerId: string) => Promise<void>;
  readonly activate: (material: WalletMaterialV2) => Promise<void>;
};

export type SeedInstaller = (
  seedPhrase: string,
  password?: string,
  restore?: (material: WalletMaterialV2) => Promise<void>,
) => Promise<void>;

export const createSeedInstaller =
  (options: SeedInstallerOptions): SeedInstaller =>
  async (seedPhrase, password, restore) => {
    if (!isValidSeedPhrase(seedPhrase)) throw new Error('Not a valid seed phrase.');
    const material = deriveWalletMaterial(seedPhrase);
    await options.prepareInstallation(walletMaterialOwnerId(material));
    if (restore) await restore(material);
    // a restore engine may have installed a legacy linking-key record from
    // the backup payload: the v2 lifecycle never activates it, so it is
    // residue - removing it here also fences old tabs still watching that key
    localStorage.removeItem(LINKING_KEY_STORAGE_KEY);
    await saveWalletMaterial(material, password);
    await options.activate(material);
  };
