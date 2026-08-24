// Owner-bound trusted-mint persistence. Web Locks serialize writers while an
// IndexedDB commit mirror bridges stale cross-renderer localStorage views.

import {isWalletOwnerId} from './storage/walletOwner'
import {savedKeyOwnerAllows} from './storage/currentOwner'
import {storageLocksAvailable, withStorageLock} from './storageLock'
import type {TrustedMint} from './trustedMints'
import {trustedMintsCommitStore} from './trustedMintsCommitStore'
import {notifyStoredTrustedMintsChange, TRUSTED_MINTS_STORAGE_KEY} from './trustedMintsEvents'
import {
  parseLegacyTrustedMintsRegistry,
  parseStoredTrustedMintsRegistry,
  serializeTrustedMintsRegistry,
  type StoredTrustedMintsRegistry,
} from './trustedMintsRegistry'
import type {MintTransition} from './trustedMintTransitions'

const STORAGE_KEY = TRUSTED_MINTS_STORAGE_KEY

type MutationState = {
  readonly canonicalRaw: string | null
  readonly current: TrustedMint[]
  readonly localRaw: string | null
  readonly mirrorEnabled: boolean
}

export class InvalidTrustedMintsOwnerError extends Error {
  override readonly name = 'InvalidTrustedMintsOwnerError'

  constructor() {
    super('Trusted-mint mutation requires a valid wallet owner.')
  }
}

export class TrustedMintsOwnerMismatchError extends Error {
  override readonly name = 'TrustedMintsOwnerMismatchError'

  constructor() {
    super('Trusted-mint registry belongs to a different wallet owner.')
  }
}

export class MalformedTrustedMintsRegistryError extends Error {
  override readonly name = 'MalformedTrustedMintsRegistryError'

  constructor() {
    super('Trusted-mint registry storage is malformed.')
  }
}

const requireOwnedRegistry = (
  stored: StoredTrustedMintsRegistry,
  ownerId: string,
): StoredTrustedMintsRegistry => {
  if (stored.kind === 'malformed') throw new MalformedTrustedMintsRegistryError()
  if (stored.kind === 'valid' && stored.envelope.ownerId !== ownerId) {
    throw new TrustedMintsOwnerMismatchError()
  }
  return stored
}

const mirrorIsEnabled = (): boolean =>
  storageLocksAvailable() && trustedMintsCommitStore.available()

const readMutationState = async (ownerId: string): Promise<MutationState> => {
  const localRaw = localStorage.getItem(STORAGE_KEY)
  const local = requireOwnedRegistry(parseStoredTrustedMintsRegistry(localRaw), ownerId)
  const mirrorEnabled = mirrorIsEnabled()
  if (!mirrorEnabled) {
    return {
      canonicalRaw: localRaw,
      current: local.kind === 'valid' ? local.envelope.mints : [],
      localRaw,
      mirrorEnabled,
    }
  }

  const mirrorRaw = await trustedMintsCommitStore.read()
  if (mirrorRaw === null) {
    return {
      canonicalRaw: localRaw,
      current: local.kind === 'valid' ? local.envelope.mints : [],
      localRaw,
      mirrorEnabled,
    }
  }
  const mirror = requireOwnedRegistry(parseStoredTrustedMintsRegistry(mirrorRaw), ownerId)
  if (mirror.kind !== 'valid') throw new MalformedTrustedMintsRegistryError()
  return {
    canonicalRaw: mirrorRaw,
    current: mirror.envelope.mints,
    localRaw,
    mirrorEnabled,
  }
}

const restoreLocalRegistry = (raw: string | null): void => {
  if (raw === null) localStorage.removeItem(STORAGE_KEY)
  else localStorage.setItem(STORAGE_KEY, raw)
}

const commitRegistry = async (
  previousRaw: string | null,
  nextRaw: string,
  mirrorEnabled: boolean,
): Promise<boolean> => {
  const localChanged = previousRaw !== nextRaw
  if (localChanged) localStorage.setItem(STORAGE_KEY, nextRaw)
  if (!mirrorEnabled) return localChanged
  try {
    await trustedMintsCommitStore.write(nextRaw)
  } catch (error) {
    if (localChanged) restoreLocalRegistry(previousRaw)
    throw error
  }
  return localChanged
}

export {onStoredTrustedMintsChange} from './trustedMintsEvents'

export const readOwnedTrustedMints = (ownerId: unknown): TrustedMint[] => {
  if (!isWalletOwnerId(ownerId)) return []
  const stored = parseStoredTrustedMintsRegistry(localStorage.getItem(STORAGE_KEY))
  return stored.kind === 'valid' && stored.envelope.ownerId === ownerId ? stored.envelope.mints : []
}

export const mutateStoredTrustedMints = async <T>(
  ownerId: unknown,
  transition: (mints: TrustedMint[]) => MintTransition<T>,
): Promise<T> => {
  if (!isWalletOwnerId(ownerId)) throw new InvalidTrustedMintsOwnerError()

  const committed = await withStorageLock(STORAGE_KEY, async () => {
    if (!savedKeyOwnerAllows(ownerId)) throw new TrustedMintsOwnerMismatchError()
    const state = await readMutationState(ownerId)
    const next = transition(state.current)
    const nextRaw = next.changed
      ? serializeTrustedMintsRegistry(ownerId, next.mints)
      : state.canonicalRaw
    const localChanged =
      nextRaw === null ? false : await commitRegistry(state.localRaw, nextRaw, state.mirrorEnabled)
    return {localChanged, result: next.result}
  })

  if (committed.localChanged) notifyStoredTrustedMintsChange()
  return committed.result
}

export const adoptLegacyStoredTrustedMints = async (ownerId: unknown): Promise<number> => {
  if (!isWalletOwnerId(ownerId)) throw new InvalidTrustedMintsOwnerError()
  const adopted = await withStorageLock(STORAGE_KEY, async () => {
    if (!savedKeyOwnerAllows(ownerId)) throw new TrustedMintsOwnerMismatchError()
    const localRaw = localStorage.getItem(STORAGE_KEY)
    const legacy = parseLegacyTrustedMintsRegistry(localRaw)
    if (legacy === null) {
      requireOwnedRegistry(parseStoredTrustedMintsRegistry(localRaw), ownerId)
      return null
    }
    await commitRegistry(
      localRaw,
      serializeTrustedMintsRegistry(ownerId, legacy),
      mirrorIsEnabled(),
    )
    return legacy
  })
  if (adopted !== null) notifyStoredTrustedMintsChange()
  return adopted?.length ?? 0
}

export const removeStoredTrustedMintsForOwner = async (ownerId: unknown): Promise<void> => {
  if (!isWalletOwnerId(ownerId)) throw new InvalidTrustedMintsOwnerError()
  const removed = await withStorageLock(STORAGE_KEY, async () => {
    if (!savedKeyOwnerAllows(ownerId)) throw new TrustedMintsOwnerMismatchError()
    const state = await readMutationState(ownerId)
    if (state.canonicalRaw === null) return false
    if (state.localRaw !== null) localStorage.removeItem(STORAGE_KEY)
    try {
      if (state.mirrorEnabled) await trustedMintsCommitStore.clear()
    } catch (error) {
      if (state.localRaw !== null) restoreLocalRegistry(state.localRaw)
      throw error
    }
    return true
  })
  if (removed) notifyStoredTrustedMintsChange()
}

export const resetStoredTrustedMints = async (): Promise<void> => {
  const removed = await withStorageLock(STORAGE_KEY, async () => {
    const localRaw = localStorage.getItem(STORAGE_KEY)
    if (localRaw !== null) localStorage.removeItem(STORAGE_KEY)
    try {
      if (mirrorIsEnabled()) await trustedMintsCommitStore.clear()
    } catch (error) {
      if (localRaw !== null) restoreLocalRegistry(localRaw)
      throw error
    }
    return localRaw !== null
  })
  if (removed) notifyStoredTrustedMintsChange()
}
