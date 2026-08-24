// Legacy passkey slots may be adopted only after another unlock path has
// proven and stamped the saved wallet owner. The linking key is checked
// against that marker before markerless slots are changed under the lock.

import {linkingPubKeyHex, savedKeyOwnerId} from './keys'
import {adoptLegacyPasskeySlots, PASSKEY_SLOTS_STORAGE_KEY} from './storage/passkeySlots'
import {withStorageLock} from './storageLock'

export const migrateLegacyPasskeySlots = async (linkingKey: Uint8Array): Promise<number> => {
  const ownerId = savedKeyOwnerId()
  if (ownerId === null || linkingPubKeyHex(linkingKey) !== ownerId) {
    throw new Error('Legacy passkey migration requires a proven owner.')
  }
  return withStorageLock(PASSKEY_SLOTS_STORAGE_KEY, () => adoptLegacyPasskeySlots(ownerId))
}
