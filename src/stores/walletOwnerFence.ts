import { assertSavedKeyOwner, WalletOwnerMismatchError } from '@/lnurlcash/storage/currentOwner';

export type WalletState = 'none' | 'locked' | 'unlocked';
export type WalletOwnerFence = () => void;

type WalletOwnerFenceOptions = Readonly<{
  state: () => WalletState;
  ownerId: () => string | null;
  lifecycleToken: () => number;
  accepting: () => boolean;
}>;

export const createWalletOwnerFence = (options: WalletOwnerFenceOptions) => {
  const assertCurrentOwner = (): void => {
    const ownerId = options.ownerId();
    if (options.state() !== 'unlocked' || ownerId === null) {
      throw new WalletOwnerMismatchError();
    }
    assertSavedKeyOwner(ownerId);
  };

  const capture = (): WalletOwnerFence => {
    if (!options.accepting()) throw new WalletOwnerMismatchError();
    assertCurrentOwner();
    const token = options.lifecycleToken();
    const ownerId = options.ownerId();
    if (ownerId === null) throw new WalletOwnerMismatchError();
    return () => {
      if (options.lifecycleToken() !== token || options.ownerId() !== ownerId) {
        throw new WalletOwnerMismatchError();
      }
      assertCurrentOwner();
    };
  };

  return { assertCurrentOwner, capture };
};
