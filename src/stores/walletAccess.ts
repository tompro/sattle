import {
  decryptSavedWalletMaterial,
  generateSeedPhrase,
  getPlainWalletMaterial,
  savedWalletMaterialIsEncrypted,
  savedWalletMaterialOwnerId,
} from '@/lnurlcash/keys';
import type { WalletMaterialV2 } from '@/lnurlcash/keys';
import { unlockWalletMaterialWithPasskey } from '@/lnurlcash/passkeys';
import { unlockWalletMaterialWithBiometrics } from '@/capabilities/biometricUnlock';

import { resetUnsupportedLegacyWalletState } from './walletLifecycle';

type RunTransition = <T>(transition: () => Promise<T>) => Promise<T>;
type InstallSeed = (seedPhrase: string, password?: string) => Promise<void>;
type Activate = (material: WalletMaterialV2, ownerWasMissing: boolean) => Promise<void>;

type WalletAccessOptions = Readonly<{
  runTransition: RunTransition;
  installSeed: InstallSeed;
  activate: Activate;
  canInit: () => boolean;
  // reset failures must surface without killing boot: routing proceeds to
  // the uninstalled state and the next install attempt retries the reset
  onResetError: (error: unknown) => void;
}>;

export const createWalletAccess = ({
  runTransition,
  installSeed,
  activate,
  canInit,
  onResetError,
}: WalletAccessOptions) => {
  const activateSavedMaterial = async (material: WalletMaterialV2 | null): Promise<void> => {
    if (!material) throw new Error('No wallet on this device.');
    await activate(material, savedWalletMaterialOwnerId() === null);
  };
  const create = (password?: string): Promise<string> =>
    runTransition(async () => {
      const phrase = generateSeedPhrase();
      await installSeed(phrase, password);
      return phrase;
    });
  const restoreFromSeed = (seedPhrase: string, password?: string): Promise<void> =>
    runTransition(() => installSeed(seedPhrase, password));
  const unlock = (password?: string): Promise<void> =>
    runTransition(async () => {
      const material = savedWalletMaterialIsEncrypted()
        ? await decryptSavedWalletMaterial(password || '')
        : getPlainWalletMaterial();
      await activateSavedMaterial(material);
    });
  const unlockWithPasskeyCredential = (): Promise<void> =>
    runTransition(async () => {
      await activate(await unlockWalletMaterialWithPasskey(), false);
    });
  const unlockWithBiometric = (): Promise<void> =>
    runTransition(async () => {
      await activateSavedMaterial(await unlockWalletMaterialWithBiometrics());
    });
  const init = (): Promise<void> =>
    runTransition(async () => {
      // alpha reset runs before any routing decision can expose the wallet:
      // an unsupported legacy install is wiped, never migrated
      try {
        await resetUnsupportedLegacyWalletState();
      } catch (error) {
        onResetError(error);
      }
      if (!canInit() || savedWalletMaterialIsEncrypted()) return;
      await activateSavedMaterial(getPlainWalletMaterial());
    });
  return {
    create,
    init,
    restoreFromSeed,
    unlock,
    unlockWithBiometric,
    unlockWithPasskey: unlockWithPasskeyCredential,
  };
};
