// Canonical wallet material combines stable LUD-05 identity with the BIP-32
// cash root. Its hash commits to equality and freshness only; wallet identity
// remains derived exclusively from the linking key.

import {secp256k1} from '@noble/curves/secp256k1.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {cashNodeFromHex, cashNodeToHex} from 'lnurlcash-kit'

import {isJsonObject} from '../jsonParsing'

export const WALLET_MATERIAL_VERSION = 2 as const
export const STORED_WALLET_MATERIAL_VERSION = 2 as const

export type WalletMaterialV2 = {
  readonly version: typeof WALLET_MATERIAL_VERSION
  readonly linkingKeyHex: string
  readonly cashRootHex: string
}

const WALLET_MATERIAL_KEYS = ['version', 'linkingKeyHex', 'cashRootHex'] as const

const hasExactlyKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).length === expected.length &&
  Object.keys(value).every((key) => expected.includes(key))

export const serializeWalletMaterial = (material: WalletMaterialV2): string =>
  JSON.stringify({
    version: WALLET_MATERIAL_VERSION,
    linkingKeyHex: material.linkingKeyHex,
    cashRootHex: material.cashRootHex,
  })

export const serializedWalletMaterialHash = (serialized: string): string =>
  bytesToHex(sha256(utf8ToBytes(serialized)))

export const walletMaterialHash = (material: WalletMaterialV2): string =>
  serializedWalletMaterialHash(serializeWalletMaterial(material))

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
