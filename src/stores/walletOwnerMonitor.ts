import { savedKeyOwnerId } from '@/lnurlcash/keys';
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

export const startWalletOwnerMonitor = (monitor: WalletOwnerMonitor): (() => void) =>
  onSavedKeyStorageChange(() => {
    const expected = monitor.snapshot();
    if (
      expected.state !== 'unlocked' ||
      expected.ownerId === null ||
      savedKeyOwnerId() === expected.ownerId
    ) {
      return;
    }
    void monitor.runTransition(async () => {
      const current = monitor.snapshot();
      if (
        current.token !== expected.token ||
        current.state !== 'unlocked' ||
        current.ownerId !== expected.ownerId ||
        savedKeyOwnerId() === expected.ownerId
      ) {
        return;
      }
      await monitor.deactivate();
    });
  });
