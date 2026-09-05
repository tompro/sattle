import { defineBoot } from '#q-app';
import { useWalletStore } from '@/stores/wallet';
import { useNostrBackupStore } from '@/stores/nostrBackup';
import { useNwcStore } from '@/stores/nwc';

declare global {
  interface Window {
    __sattleWalletTest?: {
      readonly state: () => ReturnType<typeof useWalletStore>['state'];
      readonly forget: () => Promise<void>;
    };
  }
}

// Wallet lifecycle bootstrap: reflects whatever is on this device into the
// wallet store at app start - a plaintext-stored material record unlocks
// straight away, a password-encrypted one lands on 'locked' for the unlock
// screen, and no record at all lands on 'none' for onboarding. init() first
// runs the alpha reset: unsupported legacy state (the linking-key-only
// record or the pre-v2 bearer namespace) is wiped, never migrated, before
// any route can expose it.
export default defineBoot(async () => {
  const wallet = useWalletStore();
  await wallet.init();
  // instantiating the store arms its watchers: while the wallet is unlocked
  // and nostr backup is enabled, store changes schedule debounced publishes
  useNostrBackupStore();
  // same arming for NWC: while enabled and unlocked, the service answers
  // client requests; on lock it stops and drops the key-material closure
  useNwcStore();
});

// dev-only e2e hook: lets a spec observe the wallet state and drive the
// forget transition, which has no UI surface. Never in production builds.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__sattleWalletTest = {
    state: () => useWalletStore().state,
    forget: () => useWalletStore().forgetWallet(),
  };
}
