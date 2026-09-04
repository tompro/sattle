// Passkey-slot persistence: every v2 slot is bound to the canonical owner
// of the saved wallet material. localStorage remains hostile input, so owner
// markers are parsed strictly and reads expose only slots belonging to the
// currently proven saved owner. Mutations preserve every other record.

import {isJsonObject} from '../jsonParsing'
import type {WalletMaterialV2} from './storedSecret'
import {serializeWalletMaterial, walletMaterialHash, walletMaterialOwnerId} from './storedSecret'
import {
  getPlainWalletMaterial,
  savedWalletMaterialHash,
  savedWalletMaterialOwnerId,
} from '../walletMaterialStorage'
import {isWalletOwnerId} from './walletOwner'

export type PasskeyWrap = {
  readonly hkdfSalt: string
  readonly iv: string
  readonly materialHash: string
  readonly wrappedMaterial: string
}

export const PASSKEY_SLOT_VERSION = 2 as const

export type PasskeySlot = PasskeyWrap & {
  readonly credentialId: string
  readonly createdAt: number
  readonly name?: string
  readonly ownerId: string
  readonly version: typeof PASSKEY_SLOT_VERSION
}

export const passkeySlotsEqual = (left: PasskeySlot, right: PasskeySlot): boolean =>
  left.credentialId === right.credentialId &&
  left.hkdfSalt === right.hkdfSalt &&
  left.iv === right.iv &&
  left.materialHash === right.materialHash &&
  left.wrappedMaterial === right.wrappedMaterial &&
  left.createdAt === right.createdAt &&
  left.name === right.name &&
  left.ownerId === right.ownerId &&
  left.version === right.version

export const requireCurrentPasskeyMaterialOwner = (material: WalletMaterialV2): string => {
  const ownerId = savedWalletMaterialOwnerId()
  const materialHash = savedWalletMaterialHash()
  const plaintext = getPlainWalletMaterial()
  if (
    ownerId === null ||
    materialHash === null ||
    walletMaterialOwnerId(material) !== ownerId ||
    walletMaterialHash(material) !== materialHash ||
    (plaintext !== null && serializeWalletMaterial(plaintext) !== serializeWalletMaterial(material))
  ) {
    throw new Error('Passkey operation requires the proven saved wallet material.')
  }
  return ownerId
}

type StoredPasskeySlot = PasskeyWrap & {
  readonly credentialId: string
  readonly createdAt: number
  readonly name?: string
  readonly ownerId?: unknown
  readonly version?: unknown
}

type ParsedPasskeySlot = {
  readonly record: StoredPasskeySlot
  readonly claimedOwnerId: string | null
  readonly isCurrent: boolean
}

export const PASSKEY_SLOTS_STORAGE_KEY = 'sattle_passkey_slots'

const SLOT_KEYS: readonly string[] = [
  'credentialId',
  'hkdfSalt',
  'iv',
  'materialHash',
  'wrappedMaterial',
  'createdAt',
  'name',
  'ownerId',
  'version',
]

const parseStoredPasskeySlot = (slot: unknown): ParsedPasskeySlot | null => {
  if (!isJsonObject(slot)) return null
  if (
    typeof slot.credentialId === 'string' &&
    slot.credentialId.length > 0 &&
    slot.credentialId.length % 2 === 0 &&
    /^[0-9a-f]+$/i.test(slot.credentialId) &&
    typeof slot.hkdfSalt === 'string' &&
    /^[0-9a-f]{32}$/i.test(slot.hkdfSalt) &&
    typeof slot.iv === 'string' &&
    /^[0-9a-f]{24}$/i.test(slot.iv) &&
    typeof slot.materialHash === 'string' &&
    /^[0-9a-f]{64}$/.test(slot.materialHash) &&
    typeof slot.wrappedMaterial === 'string' &&
    slot.wrappedMaterial.length > 0 &&
    slot.wrappedMaterial.length % 2 === 0 &&
    /^[0-9a-f]+$/.test(slot.wrappedMaterial) &&
    typeof slot.createdAt === 'number' &&
    (slot.name === undefined || typeof slot.name === 'string') &&
    Object.keys(slot).every((key) => SLOT_KEYS.includes(key))
  ) {
    const record: StoredPasskeySlot = {
      credentialId: slot.credentialId,
      hkdfSalt: slot.hkdfSalt,
      iv: slot.iv,
      materialHash: slot.materialHash,
      wrappedMaterial: slot.wrappedMaterial,
      createdAt: slot.createdAt,
      ...(slot.name !== undefined ? {name: slot.name} : {}),
    }
    const hasOwner = Object.hasOwn(slot, 'ownerId')
    const hasVersion = Object.hasOwn(slot, 'version')
    if (!hasOwner && !hasVersion) return {record, claimedOwnerId: null, isCurrent: false}
    if (!isWalletOwnerId(slot.ownerId)) return null
    if (!hasVersion) {
      return {
        record: {...record, ownerId: slot.ownerId},
        claimedOwnerId: slot.ownerId,
        isCurrent: false,
      }
    }
    if (slot.version !== PASSKEY_SLOT_VERSION) return null
    return {
      record: {...record, ownerId: slot.ownerId, version: PASSKEY_SLOT_VERSION},
      claimedOwnerId: slot.ownerId,
      isCurrent: true,
    }
  }
  return null
}

const readStoredPasskeySlots = (): ParsedPasskeySlot[] => {
  const raw = localStorage.getItem(PASSKEY_SLOTS_STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const slots: ParsedPasskeySlot[] = []
    for (const value of parsed) {
      const slot = parseStoredPasskeySlot(value)
      if (slot !== null) slots.push(slot)
    }
    return slots
  } catch {
    return []
  }
}

const asOwnedSlot = (stored: ParsedPasskeySlot, ownerId: string): PasskeySlot | null => {
  if (!stored.isCurrent || stored.claimedOwnerId !== ownerId) {
    return null
  }
  const record = stored.record
  return {
    credentialId: record.credentialId,
    hkdfSalt: record.hkdfSalt,
    iv: record.iv,
    materialHash: record.materialHash,
    wrappedMaterial: record.wrappedMaterial,
    createdAt: record.createdAt,
    ...(record.name !== undefined ? {name: record.name} : {}),
    ownerId,
    version: PASSKEY_SLOT_VERSION,
  }
}

export const readPasskeySlots = (): PasskeySlot[] => {
  const ownerId = savedWalletMaterialOwnerId()
  if (ownerId === null) return []
  return readStoredPasskeySlots()
    .map((slot) => asOwnedSlot(slot, ownerId))
    .filter((slot): slot is PasskeySlot => slot !== null)
}

export const hasPasskeySlots = (): boolean => readPasskeySlots().length > 0

export const writePasskeySlots = (ownerId: string, slots: PasskeySlot[]): void => {
  const materialHash = savedWalletMaterialHash()
  if (
    !isWalletOwnerId(ownerId) ||
    savedWalletMaterialOwnerId() !== ownerId ||
    materialHash === null
  ) {
    throw new Error('Passkey slots require the proven saved wallet owner.')
  }
  if (
    slots.some(
      (slot) =>
        slot.ownerId !== ownerId ||
        slot.version !== PASSKEY_SLOT_VERSION ||
        slot.materialHash !== materialHash,
    )
  ) {
    throw new Error('Refusing to write a passkey slot for a different wallet.')
  }
  const preserved = readStoredPasskeySlots()
    .filter((slot) => slot.claimedOwnerId !== ownerId)
    .map((slot) => slot.record)
  localStorage.setItem(PASSKEY_SLOTS_STORAGE_KEY, JSON.stringify([...preserved, ...slots]))
}

export const adoptLegacyPasskeySlots = (ownerId: string): number => {
  const materialHash = savedWalletMaterialHash()
  if (!isWalletOwnerId(ownerId) || savedWalletMaterialOwnerId() !== ownerId) {
    throw new Error('Legacy passkey migration requires a proven owner.')
  }
  const stored = readStoredPasskeySlots()
  let adopted = 0
  const migrated = stored.map((slot) => {
    if (
      slot.isCurrent ||
      slot.record.materialHash !== materialHash ||
      (slot.claimedOwnerId !== null && slot.claimedOwnerId !== ownerId)
    ) {
      return slot.record
    }
    adopted += 1
    return {...slot.record, ownerId, version: PASSKEY_SLOT_VERSION}
  })
  if (adopted > 0) {
    localStorage.setItem(PASSKEY_SLOTS_STORAGE_KEY, JSON.stringify(migrated))
  }
  return adopted
}

const persistStoredPasskeySlots = (slots: StoredPasskeySlot[]): void => {
  if (slots.length === 0) {
    localStorage.removeItem(PASSKEY_SLOTS_STORAGE_KEY)
    return
  }
  localStorage.setItem(PASSKEY_SLOTS_STORAGE_KEY, JSON.stringify(slots))
}

export const clearPasskeySlotsForOwner = (ownerId: string): void => {
  if (!isWalletOwnerId(ownerId) || savedWalletMaterialOwnerId() !== ownerId) {
    throw new Error('Passkey teardown requires the proven saved wallet owner.')
  }
  persistStoredPasskeySlots(
    readStoredPasskeySlots()
      .filter((slot) => slot.claimedOwnerId !== ownerId)
      .map((slot) => slot.record),
  )
}

export const clearUnownedPasskeySlots = (): void => {
  persistStoredPasskeySlots(
    readStoredPasskeySlots()
      .filter((slot) => slot.claimedOwnerId !== null)
      .map((slot) => slot.record),
  )
}
