import { defineBoot } from '#q-app';
import { useWalletStore } from '@/stores/wallet';
import { useNostrBackupStore } from '@/stores/nostrBackup';

// Wallet lifecycle bootstrap: reflects whatever is on this device into the
// wallet store at app start - a plaintext-stored key unlocks straight away,
// a password-encrypted one lands on 'locked' for the unlock screen, and no
// key at all lands on 'none' for onboarding.
export default defineBoot(async () => {
  const wallet = useWalletStore();
  await wallet.init();
  // instantiating the store arms its watchers: while the wallet is unlocked
  // and nostr backup is enabled, store changes schedule debounced publishes
  useNostrBackupStore();
});
