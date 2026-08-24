// Strict trusted-mint envelope parsing is shared by localStorage and the
// durable cross-context commit mirror. Either source fails closed as a whole.

import {isWalletOwnerId} from './storage/walletOwner'
import type {TrustedMint} from './trustedMints'
import {isValidMintPubkey} from './trustedMintTransitions'

export const TRUSTED_MINTS_REGISTRY_VERSION = 1

export type TrustedMintsRegistryEnvelope = {
  readonly version: typeof TRUSTED_MINTS_REGISTRY_VERSION
  readonly ownerId: string
  readonly mints: TrustedMint[]
}

export type StoredTrustedMintsRegistry =
  | {readonly kind: 'absent'}
  | {readonly kind: 'malformed'}
  | {readonly kind: 'valid'; readonly envelope: TrustedMintsRegistryEnvelope}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isOptionalString = (value: unknown): boolean =>
  value === undefined || typeof value === 'string'

const isOptionalNumber = (value: unknown): boolean =>
  value === undefined || typeof value === 'number'

const isTrustedMint = (value: unknown): value is TrustedMint => {
  if (!isRecord(value)) return false
  return (
    typeof value.server === 'string' &&
    typeof value.mintPubkey === 'string' &&
    isValidMintPubkey(value.mintPubkey) &&
    typeof value.addedAt === 'number' &&
    typeof value.locked === 'boolean' &&
    (value.unconfirmed === undefined || typeof value.unconfirmed === 'boolean') &&
    (value.pendingMintPubkey === undefined ||
      (typeof value.pendingMintPubkey === 'string' &&
        isValidMintPubkey(value.pendingMintPubkey))) &&
    isOptionalString(value.nodeAlias) &&
    isOptionalString(value.nodeColor) &&
    isOptionalNumber(value.nodeCapacityMsat) &&
    isOptionalNumber(value.nodeNumChannels) &&
    isOptionalNumber(value.nodeNumPeers) &&
    isOptionalString(value.username)
  )
}

export const parseStoredTrustedMintsRegistry = (raw: string | null): StoredTrustedMintsRegistry => {
  if (raw === null) return {kind: 'absent'}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      !isRecord(parsed) ||
      parsed.version !== TRUSTED_MINTS_REGISTRY_VERSION ||
      !isWalletOwnerId(parsed.ownerId) ||
      !Array.isArray(parsed.mints) ||
      !parsed.mints.every(isTrustedMint)
    ) {
      return {kind: 'malformed'}
    }
    return {
      kind: 'valid',
      envelope: {
        version: TRUSTED_MINTS_REGISTRY_VERSION,
        ownerId: parsed.ownerId,
        mints: parsed.mints,
      },
    }
  } catch {
    return {kind: 'malformed'}
  }
}

export const parseLegacyTrustedMintsRegistry = (raw: string | null): TrustedMint[] | null => {
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.every(isTrustedMint) ? parsed : null
  } catch {
    return null
  }
}

export const serializeTrustedMintsRegistry = (ownerId: string, mints: TrustedMint[]): string =>
  JSON.stringify({version: TRUSTED_MINTS_REGISTRY_VERSION, ownerId, mints})
