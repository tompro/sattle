// The v2 wallet-material repository owns one authenticated serialization under
// a new namespace. Owner markers remain claims on restore and become trusted
// only after plaintext or password proof reproduces the linking-key owner.

import {
  parseStoredWalletMaterial,
  parseWalletMaterial,
  serializeWalletMaterial,
  stampStoredWalletMaterialOwner,
  storedWalletMaterialClaimedOwnerId,
  storedWalletMaterialOwnerId,
  stripStoredWalletMaterialOwner,
  walletMaterialHash,
  walletMaterialOwnerId,
  STORED_WALLET_MATERIAL_VERSION,
} from './storage/storedSecret'
import type {StoredWalletMaterial, WalletMaterialV2} from './storage/storedSecret'
import {serializedWalletMaterialHash} from './storage/walletMaterial'
import {decryptSecretParts, encryptSecretParts} from './passwordWrap'
import {WALLET_MATERIAL_STORAGE_KEY} from './storage/walletOwnerEvents'

export class InvalidWalletMaterialError extends Error {
  override readonly name = 'InvalidWalletMaterialError'

  constructor() {
    super('Saved plaintext is not valid v2 wallet material.')
  }
}

export class WalletMaterialOwnerMismatchError extends Error {
  override readonly name = 'WalletMaterialOwnerMismatchError'

  constructor() {
    super('Saved wallet material is owned by a different wallet.')
  }
}

export class WalletMaterialProofMismatchError extends Error {
  override readonly name = 'WalletMaterialProofMismatchError'

  constructor() {
    super('Proven material does not match the saved wallet material.')
  }
}

export class NoEncryptedWalletMaterialError extends Error {
  override readonly name = 'NoEncryptedWalletMaterialError'

  constructor() {
    super('No encrypted wallet material saved.')
  }
}

const readStoredWalletMaterial = (): StoredWalletMaterial | null => {
  const raw = localStorage.getItem(WALLET_MATERIAL_STORAGE_KEY)
  if (raw === null) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
  return parseStoredWalletMaterial(value)?.secret ?? null
}

const materialFromPlaintext = (stored: StoredWalletMaterial): WalletMaterialV2 | null => {
  if (stored.enc) return null
  const material = parseWalletMaterial(stored.value)
  if (material === null) return null
  const claim = storedWalletMaterialClaimedOwnerId(stored)
  return claim === null || claim === walletMaterialOwnerId(material) ? material : null
}

export const savedWalletMaterialExists = (): boolean => readStoredWalletMaterial() !== null

export const savedWalletMaterialIsEncrypted = (): boolean =>
  readStoredWalletMaterial()?.enc === true

export const getSavedWalletMaterialStored = (): StoredWalletMaterial | null =>
  readStoredWalletMaterial()

export const savedWalletMaterialOwnerId = (): string | null => {
  const stored = readStoredWalletMaterial()
  return stored === null ? null : storedWalletMaterialOwnerId(stored)
}

export const savedWalletMaterialOwnerMatches = (material: WalletMaterialV2): boolean =>
  savedWalletMaterialOwnerId() === walletMaterialOwnerId(material)

export const savedWalletMaterialHash = (): string | null =>
  readStoredWalletMaterial()?.materialHash ?? null

export const getPlainWalletMaterial = (): WalletMaterialV2 | null => {
  const stored = readStoredWalletMaterial()
  return stored === null ? null : materialFromPlaintext(stored)
}

export const saveWalletMaterial = async (
  material: WalletMaterialV2,
  password?: string,
): Promise<void> => {
  const value = serializeWalletMaterial(material)
  const materialHash = walletMaterialHash(material)
  const ownerId = walletMaterialOwnerId(material)
  if (!password) {
    localStorage.setItem(
      WALLET_MATERIAL_STORAGE_KEY,
      JSON.stringify({
        enc: false,
        value,
        materialHash,
        ownerId,
        version: STORED_WALLET_MATERIAL_VERSION,
      }),
    )
    return
  }
  const parts = await encryptSecretParts(value, password)
  localStorage.setItem(
    WALLET_MATERIAL_STORAGE_KEY,
    JSON.stringify({
      enc: true,
      ...parts,
      materialHash,
      ownerId,
      version: STORED_WALLET_MATERIAL_VERSION,
    }),
  )
}

export const restoreWalletMaterialStored = (stored: StoredWalletMaterial): void => {
  const parsed = parseStoredWalletMaterial(stored)
  if (parsed === null) throw new InvalidWalletMaterialError()
  localStorage.setItem(
    WALLET_MATERIAL_STORAGE_KEY,
    JSON.stringify(stripStoredWalletMaterialOwner(parsed.secret)),
  )
}

export const decryptSavedWalletMaterial = async (
  password: string,
): Promise<WalletMaterialV2> => {
  const stored = readStoredWalletMaterial()
  if (stored === null || !stored.enc) throw new NoEncryptedWalletMaterialError()
  const serialized = await decryptSecretParts(stored, password)
  if (serializedWalletMaterialHash(serialized) !== stored.materialHash) {
    throw new WalletMaterialProofMismatchError()
  }
  const material = parseWalletMaterial(serialized)
  if (material === null) throw new InvalidWalletMaterialError()
  const claimedOwnerId = storedWalletMaterialClaimedOwnerId(stored)
  if (claimedOwnerId !== null && claimedOwnerId !== walletMaterialOwnerId(material)) {
    throw new WalletMaterialOwnerMismatchError()
  }
  return material
}

export const ensureSavedWalletMaterialOwner = (material: WalletMaterialV2): void => {
  const stored = readStoredWalletMaterial()
  if (stored === null) return
  const serialized = serializeWalletMaterial(material)
  if (
    walletMaterialHash(material) !== stored.materialHash ||
    (stored.enc === false && stored.value !== serialized)
  ) {
    throw new WalletMaterialProofMismatchError()
  }
  const ownerId = walletMaterialOwnerId(material)
  const claimedOwnerId = storedWalletMaterialClaimedOwnerId(stored)
  if (storedWalletMaterialOwnerId(stored) === ownerId) return
  if (claimedOwnerId !== null && claimedOwnerId !== ownerId) {
    throw new WalletMaterialOwnerMismatchError()
  }
  localStorage.setItem(
    WALLET_MATERIAL_STORAGE_KEY,
    JSON.stringify(stampStoredWalletMaterialOwner(stored, ownerId)),
  )
}

export const clearSavedWalletMaterial = (): void => {
  localStorage.removeItem(WALLET_MATERIAL_STORAGE_KEY)
}
