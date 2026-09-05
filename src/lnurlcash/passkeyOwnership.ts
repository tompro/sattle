// Legacy passkey slots may be adopted only after another unlock path has
// proven and stamped the saved wallet owner. The linking key is checked
// against that marker before markerless slots are changed under the lock.
// The proven marker lives on the v2 wallet-material record; adoption itself
// additionally requires the slot to commit to the exact saved material.

import { linkingPubKeyHex } from './keys';
import { adoptLegacyPasskeySlots, PASSKEY_SLOTS_STORAGE_KEY } from './storage/passkeySlots';
import { withStorageLock } from './storageLock';
import { savedWalletMaterialOwnerId } from './walletMaterialStorage';

export const migrateLegacyPasskeySlots = async (linkingKey: Uint8Array): Promise<number> => {
  const ownerId = savedWalletMaterialOwnerId();
  if (ownerId === null || linkingPubKeyHex(linkingKey) !== ownerId) {
    throw new Error('Legacy passkey migration requires a proven owner.');
  }
  return withStorageLock(PASSKEY_SLOTS_STORAGE_KEY, () => adoptLegacyPasskeySlots(ownerId));
};
