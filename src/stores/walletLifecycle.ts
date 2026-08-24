import {
  deriveWalletLinkingKey,
  ensureSavedKeyOwner,
  isValidSeedPhrase,
  linkingPubKeyHex,
  saveLinkingKey,
} from '@/lnurlcash/keys';
import { migrateLegacyPasskeySlots } from '@/lnurlcash/passkeys';
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
  linkingKey: Uint8Array,
  ownerWasMissing: boolean,
): Promise<void> => {
  ensureSavedKeyOwner(linkingKey);
  if (!ownerWasMissing) return;
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

export const ownerOf = (linkingKey: Uint8Array): string => linkingPubKeyHex(linkingKey);

type SeedInstallerOptions = {
  readonly prepareInstallation: (ownerId: string) => Promise<void>;
  readonly activate: (linkingKey: Uint8Array) => Promise<void>;
};

export type SeedInstaller = (
  seedPhrase: string,
  password?: string,
  restore?: (linkingKey: Uint8Array) => Promise<void>,
) => Promise<void>;

export const createSeedInstaller =
  (options: SeedInstallerOptions): SeedInstaller =>
  async (seedPhrase, password, restore) => {
    if (!isValidSeedPhrase(seedPhrase)) throw new Error('Not a valid seed phrase.');
    const linkingKey = deriveWalletLinkingKey(seedPhrase);
    await options.prepareInstallation(ownerOf(linkingKey));
    if (restore) await restore(linkingKey);
    await saveLinkingKey(linkingKey, password);
    await options.activate(linkingKey);
  };
