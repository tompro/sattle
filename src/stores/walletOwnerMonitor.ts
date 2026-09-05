import { savedWalletMaterialOwnerId } from '@/lnurlcash/keys';
import { onSavedKeyStorageChange } from '@/lnurlcash/storage/walletOwnerEvents';
import type { WalletState } from './walletOwnerFence';

type OwnerSnapshot = Readonly<{
  token: number;
  state: WalletState;
  ownerId: string | null;
}>;

type WalletOwnerMonitor = Readonly<{
  snapshot: () => OwnerSnapshot;
  deactivate: () => Promise<void>;
  runTransition: (transition: () => Promise<void>) => Promise<void>;
}>;

// Wakes on any saved-key storage event (the v2 material record, the legacy
// linking-key entry, or a clear) and re-reads the CURRENT v2 owner: payload
// and legacy-entry changes are only wakeups, never trusted state
export const startWalletOwnerMonitor = (monitor: WalletOwnerMonitor): (() => void) =>
  onSavedKeyStorageChange(() => {
    const expected = monitor.snapshot();
    if (
      expected.state !== 'unlocked' ||
      expected.ownerId === null ||
      savedWalletMaterialOwnerId() === expected.ownerId
    ) {
      return;
    }
    void monitor
      .runTransition(async () => {
        const current = monitor.snapshot();
        if (
          current.token !== expected.token ||
          current.state !== 'unlocked' ||
          current.ownerId !== expected.ownerId ||
          savedWalletMaterialOwnerId() === expected.ownerId
        ) {
          return;
        }
        await monitor.deactivate();
      })
      .catch(() => undefined);
  });
