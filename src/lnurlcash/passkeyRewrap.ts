// Rewrap proves every existing slot before replacing any bytes. A supplied PRF
// is therefore both authority for the old wrap and input for its fresh wrap;
// one wrong credential aborts the complete in-memory batch before persistence.

import type {WalletMaterialV2} from './storage/storedSecret'
import {serializeWalletMaterial, walletMaterialHash} from './storage/storedSecret'
import type {PasskeySlot} from './storage/passkeySlots'
import {
  PASSKEY_SLOTS_STORAGE_KEY,
  passkeySlotsEqual,
  readPasskeySlots,
  requireCurrentPasskeyMaterialOwner,
  writePasskeySlots,
} from './storage/passkeySlots'
import {withStorageLock} from './storageLock'
import {unwrapWalletMaterialWithPrf, wrapWalletMaterialWithPrf} from './passkeyWrap'

type ProvenSlot = {
  readonly slot: PasskeySlot
  readonly prfOutput: Uint8Array
}

export const rewrapAllSlots = async (
  material: WalletMaterialV2,
  prfOutputs: ReadonlyMap<string, Uint8Array>,
): Promise<void> => {
  const ownerId = requireCurrentPasskeyMaterialOwner(material)
  const materialHash = walletMaterialHash(material)
  const serialized = serializeWalletMaterial(material)
  await withStorageLock(PASSKEY_SLOTS_STORAGE_KEY, async () => {
    const provenSlots: ProvenSlot[] = readPasskeySlots().map((slot) => {
      const prfOutput = prfOutputs.get(slot.credentialId)
      if (!prfOutput) {
        throw new Error('Missing old PRF output for a passkey slot - refusing a partial re-wrap.')
      }
      return {slot, prfOutput}
    })
    for (const {slot, prfOutput} of provenSlots) {
      if (slot.materialHash !== materialHash) {
        throw new Error('Passkey slot does not match the saved wallet material.')
      }
      const current = await unwrapWalletMaterialWithPrf(prfOutput, slot)
      if (serializeWalletMaterial(current) !== serialized) {
        throw new Error('Passkey slot contains different wallet material.')
      }
    }
    const rewrapped: PasskeySlot[] = []
    for (const {slot, prfOutput} of provenSlots) {
      rewrapped.push({...slot, ...(await wrapWalletMaterialWithPrf(prfOutput, material))})
    }
    if (requireCurrentPasskeyMaterialOwner(material) !== ownerId) {
      throw new Error('Saved wallet material changed during passkey re-wrap.')
    }
    const currentSlots = readPasskeySlots()
    if (
      currentSlots.length !== provenSlots.length ||
      currentSlots.some((current, index) => {
        const original = provenSlots[index]?.slot
        return original === undefined || !passkeySlotsEqual(original, current)
      })
    ) {
      throw new Error('Passkey slots changed during re-wrap.')
    }
    writePasskeySlots(ownerId, rewrapped)
  })
}
