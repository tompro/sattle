// Saved linking-key records have two safe at-rest forms: ownerless legacy
// records and version-1 owner-bearing records. The briefly shipped
// unversioned owner-bearing shape remains readable only so a proven key can
// upgrade it; it never establishes ownership by itself. Any other metadata
// is rejected rather than downgraded to adoptable legacy data.

import {isJsonObject} from '../jsonParsing'
import {isWalletOwnerId} from './walletOwner'

export const STORED_SECRET_VERSION = 1 as const

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

type ParsedStoredSecret = {
  readonly secret: StoredSecret
  readonly claimedOwnerId: string | null
  readonly isCurrent: boolean
}

const PLAIN_KEYS = ['enc', 'value', 'ownerId', 'version'] as const
const ENCRYPTED_KEYS = ['enc', 'salt', 'iv', 'ciphertext', 'ownerId', 'version'] as const

const hasOnlyKeys = (record: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(record).every((key) => allowed.includes(key))

export const parseStoredSecret = (stored: unknown): ParsedStoredSecret | null => {
  if (!isJsonObject(stored)) return null
  let secret: StoredSecret
  if (stored.enc === false) {
    if (
      typeof stored.value !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(stored.value) ||
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
    return {
      secret: {...secret, ownerId: stored.ownerId},
      claimedOwnerId: stored.ownerId,
      isCurrent: false,
    }
  }
  if (stored.version !== STORED_SECRET_VERSION) return null
  return {
    secret: {...secret, ownerId: stored.ownerId, version: STORED_SECRET_VERSION},
    claimedOwnerId: stored.ownerId,
    isCurrent: true,
  }
}

export const isValidStoredSecret = (stored: unknown): stored is StoredSecret =>
  parseStoredSecret(stored) !== null

export const storedSecretOwnerId = (stored: StoredSecret): string | null => {
  const parsed = parseStoredSecret(stored)
  return parsed?.isCurrent === true ? parsed.claimedOwnerId : null
}

export const storedSecretClaimedOwnerId = (stored: StoredSecret): string | null =>
  parseStoredSecret(stored)?.claimedOwnerId ?? null

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

export const stripStoredSecretOwner = (stored: StoredSecret): StoredSecret => {
  if (stored.enc === false) return {enc: false, value: stored.value}
  return {
    enc: true,
    salt: stored.salt,
    iv: stored.iv,
    ciphertext: stored.ciphertext,
  }
}
