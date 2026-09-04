// Saved secret records bind either the legacy linking key or canonical v2
// wallet material to a proven owner. The v2 parser accepts only one exact,
// canonical material encoding so hostile storage cannot smuggle a legacy key,
// a future field, or a malformed BIP-32 root across the unlock boundary.

import {secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {cashNodeFromHex, cashNodeToHex} from 'lnurlcash-kit'
import {isJsonObject} from '../jsonParsing'
import {isWalletOwnerId} from './walletOwner'

export const STORED_SECRET_VERSION = 1 as const
export const WALLET_MATERIAL_VERSION = 2 as const
export const STORED_WALLET_MATERIAL_VERSION = 2 as const

export type WalletMaterialV2 = {
  readonly version: typeof WALLET_MATERIAL_VERSION
  readonly linkingKeyHex: string
  readonly cashRootHex: string
}

type PlainStoredSecret = {
  readonly enc: false
  readonly value: string
  readonly ownerId?: unknown
  readonly version?: unknown
}

type EncryptedStoredSecret = {
  readonly enc: true
  readonly salt: string
  readonly iv: string
  readonly ciphertext: string
  readonly ownerId?: unknown
  readonly version?: unknown
}

export type StoredSecret = PlainStoredSecret | EncryptedStoredSecret
export type StoredWalletMaterial = StoredSecret

type ParsedStoredSecret = {
  readonly secret: StoredSecret
  readonly claimedOwnerId: string | null
  readonly isCurrent: boolean
}

const PLAIN_KEYS = ['enc', 'value', 'ownerId', 'version'] as const
const ENCRYPTED_KEYS = ['enc', 'salt', 'iv', 'ciphertext', 'ownerId', 'version'] as const
const WALLET_MATERIAL_KEYS = ['version', 'linkingKeyHex', 'cashRootHex'] as const

const hasOnlyKeys = (record: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(record).every((key) => allowed.includes(key))

const hasExactlyKeys = (record: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(record).length === expected.length && hasOnlyKeys(record, expected)

export const serializeWalletMaterial = (material: WalletMaterialV2): string =>
  JSON.stringify({
    version: WALLET_MATERIAL_VERSION,
    linkingKeyHex: material.linkingKeyHex,
    cashRootHex: material.cashRootHex,
  })

export const parseWalletMaterial = (serialized: string): WalletMaterialV2 | null => {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
  if (
    !isJsonObject(value) ||
    !hasExactlyKeys(value, WALLET_MATERIAL_KEYS) ||
    value.version !== WALLET_MATERIAL_VERSION ||
    typeof value.linkingKeyHex !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.linkingKeyHex) ||
    typeof value.cashRootHex !== 'string' ||
    !/^[0-9a-f]{128}$/.test(value.cashRootHex)
  ) {
    return null
  }
  const linkingKey = hexToBytes(value.linkingKeyHex)
  const cashRoot = cashNodeFromHex(value.cashRootHex)
  if (
    !secp256k1.utils.isValidSecretKey(linkingKey) ||
    !secp256k1.utils.isValidSecretKey(cashRoot.privateKey) ||
    cashNodeToHex(cashRoot) !== value.cashRootHex
  ) {
    return null
  }
  const material: WalletMaterialV2 = {
    version: WALLET_MATERIAL_VERSION,
    linkingKeyHex: value.linkingKeyHex,
    cashRootHex: value.cashRootHex,
  }
  return serializeWalletMaterial(material) === serialized ? material : null
}

export const walletMaterialOwnerId = (material: WalletMaterialV2): string =>
  bytesToHex(secp256k1.getPublicKey(hexToBytes(material.linkingKeyHex), true))

type StoredSecretParserOptions = {
  readonly version: number
  readonly acceptsPlaintext: (value: string) => boolean
  readonly acceptsUnversionedOwner: boolean
}

const parseStoredSecretWith = (
  stored: unknown,
  options: StoredSecretParserOptions,
): ParsedStoredSecret | null => {
  if (!isJsonObject(stored)) return null
  let secret: StoredSecret
  if (stored.enc === false) {
    if (
      typeof stored.value !== 'string' ||
      !options.acceptsPlaintext(stored.value) ||
      !hasOnlyKeys(stored, PLAIN_KEYS)
    ) {
      return null
    }
    secret = {enc: false, value: stored.value}
  } else if (stored.enc === true) {
    if (
      typeof stored.salt !== 'string' ||
      !/^[0-9a-f]{32}$/i.test(stored.salt) ||
      typeof stored.iv !== 'string' ||
      !/^[0-9a-f]{24}$/i.test(stored.iv) ||
      typeof stored.ciphertext !== 'string' ||
      stored.ciphertext.length === 0 ||
      stored.ciphertext.length % 2 !== 0 ||
      !/^[0-9a-f]+$/i.test(stored.ciphertext) ||
      !hasOnlyKeys(stored, ENCRYPTED_KEYS)
    ) {
      return null
    }
    secret = {
      enc: true,
      salt: stored.salt,
      iv: stored.iv,
      ciphertext: stored.ciphertext,
    }
  } else {
    return null
  }

  const hasOwner = Object.hasOwn(stored, 'ownerId')
  const hasVersion = Object.hasOwn(stored, 'version')
  if (!hasOwner && !hasVersion) return {secret, claimedOwnerId: null, isCurrent: false}
  if (!isWalletOwnerId(stored.ownerId)) return null
  if (!hasVersion) {
    if (!options.acceptsUnversionedOwner) return null
    return {
      secret: {...secret, ownerId: stored.ownerId},
      claimedOwnerId: stored.ownerId,
      isCurrent: false,
    }
  }
  if (stored.version !== options.version) return null
  return {
    secret: {...secret, ownerId: stored.ownerId, version: options.version},
    claimedOwnerId: stored.ownerId,
    isCurrent: true,
  }
}

export const parseStoredSecret = (stored: unknown): ParsedStoredSecret | null =>
  parseStoredSecretWith(stored, {
    version: STORED_SECRET_VERSION,
    acceptsPlaintext: (value) => /^[0-9a-f]{64}$/i.test(value),
    acceptsUnversionedOwner: true,
  })

export const parseStoredWalletMaterial = (stored: unknown): ParsedStoredSecret | null =>
  parseStoredSecretWith(stored, {
    version: STORED_WALLET_MATERIAL_VERSION,
    acceptsPlaintext: (value) => parseWalletMaterial(value) !== null,
    acceptsUnversionedOwner: false,
  })

export const isValidStoredSecret = (stored: unknown): stored is StoredSecret =>
  parseStoredSecret(stored) !== null

export const isValidStoredWalletMaterial = (stored: unknown): stored is StoredWalletMaterial =>
  parseStoredWalletMaterial(stored) !== null

export const storedSecretOwnerId = (stored: StoredSecret): string | null => {
  const parsed = parseStoredSecret(stored)
  return parsed?.isCurrent === true ? parsed.claimedOwnerId : null
}

export const storedSecretClaimedOwnerId = (stored: StoredSecret): string | null =>
  parseStoredSecret(stored)?.claimedOwnerId ?? null

export const storedWalletMaterialOwnerId = (stored: StoredWalletMaterial): string | null => {
  const parsed = parseStoredWalletMaterial(stored)
  return parsed?.isCurrent === true ? parsed.claimedOwnerId : null
}

export const storedWalletMaterialClaimedOwnerId = (
  stored: StoredWalletMaterial,
): string | null => parseStoredWalletMaterial(stored)?.claimedOwnerId ?? null

export const stampStoredSecretOwner = (stored: StoredSecret, ownerId: string): StoredSecret => {
  if (stored.enc === false) {
    return {enc: false, value: stored.value, ownerId, version: STORED_SECRET_VERSION}
  }
  return {
    enc: true,
    salt: stored.salt,
    iv: stored.iv,
    ciphertext: stored.ciphertext,
    ownerId,
    version: STORED_SECRET_VERSION,
  }
}

export const stampStoredWalletMaterialOwner = (
  stored: StoredWalletMaterial,
  ownerId: string,
): StoredWalletMaterial => {
  if (stored.enc === false) {
    return {
      enc: false,
      value: stored.value,
      ownerId,
      version: STORED_WALLET_MATERIAL_VERSION,
    }
  }
  return {
    enc: true,
    salt: stored.salt,
    iv: stored.iv,
    ciphertext: stored.ciphertext,
    ownerId,
    version: STORED_WALLET_MATERIAL_VERSION,
  }
}

export const stripStoredSecretOwner = (stored: StoredSecret): StoredSecret => {
  if (stored.enc === false) return {enc: false, value: stored.value}
  return {
    enc: true,
    salt: stored.salt,
    iv: stored.iv,
    ciphertext: stored.ciphertext,
  }
}
