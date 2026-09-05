// Mutators must not let a still-running old tab overwrite namespaces after a
// successor has installed its saved-key owner marker. Ownerless data may only
// move through explicit migration APIs after their own proof checks succeed.
//
// The canonical owner lives on the v2 wallet-material record. The legacy
// linking-key record is accepted as a fallback so engine-level consumers and
// their harnesses keep working while the lifecycle cuts over; the cut-over
// lifecycle itself never writes that record and deletes it at install,
// reset, backup-restore, and teardown time, so in the shipped app only the
// v2 branch can ever match.

import { savedKeyOwnerId } from '../keys';
import { savedWalletMaterialOwnerId } from '../walletMaterialStorage';

export class WalletOwnerMismatchError extends Error {
  override readonly name = 'WalletOwnerMismatchError';
  constructor() {
    super('The active wallet owner no longer matches the saved wallet.');
  }
}

export const savedKeyOwnerAllows = (ownerId: string): boolean => {
  return savedWalletMaterialOwnerId() === ownerId || savedKeyOwnerId() === ownerId;
};

export const assertSavedKeyOwner = (ownerId: string): void => {
  if (!savedKeyOwnerAllows(ownerId)) throw new WalletOwnerMismatchError();
};
