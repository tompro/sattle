import {
  decryptSavedLinkingKey,
  generateSeedPhrase,
  getPlainLinkingKey,
  savedKeyIsEncrypted,
  savedKeyOwnerId,
} from '@/lnurlcash/keys';
import { unlockWithPasskey } from '@/lnurlcash/passkeys';
import { unlockWithBiometrics } from '@/capabilities/biometricUnlock';

type RunTransition = <T>(transition: () => Promise<T>) => Promise<T>;
type InstallSeed = (seedPhrase: string, password?: string) => Promise<void>;
type Activate = (linkingKey: Uint8Array, ownerWasMissing: boolean) => Promise<void>;

type WalletAccessOptions = Readonly<{
  runTransition: RunTransition;
  installSeed: InstallSeed;
  activate: Activate;
  canInit: () => boolean;
}>;

export const createWalletAccess = ({
  runTransition,
  installSeed,
  activate,
  canInit,
}: WalletAccessOptions) => {
  const activateSavedKey = async (linkingKey: Uint8Array | null): Promise<void> => {
    if (!linkingKey) throw new Error('No wallet on this device.');
    await activate(linkingKey, savedKeyOwnerId() === null);
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
      const linkingKey = savedKeyIsEncrypted()
        ? await decryptSavedLinkingKey(password || '')
        : getPlainLinkingKey();
      await activateSavedKey(linkingKey);
    });
  const unlockWithPasskeyCredential = (): Promise<void> =>
    runTransition(async () => {
      await activate(await unlockWithPasskey(), false);
    });
  const unlockWithBiometric = (): Promise<void> =>
    runTransition(async () => {
      await activateSavedKey(await unlockWithBiometrics());
    });
  const init = (): Promise<void> =>
    runTransition(async () => {
      if (!canInit() || savedKeyIsEncrypted()) return;
      await activateSavedKey(getPlainLinkingKey());
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
