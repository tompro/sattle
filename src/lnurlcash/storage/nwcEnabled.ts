// NWC service-enabled persistence: one owner-bearing record for whether the
// wallet service should run. Split from nwcConnections.ts (size ceiling) -
// the enabled flag and the connection records are independent storage keys
// with the same ownership rules: hostile input is parsed before use, and a
// legacy global 'true'/'false' string counts as ownerless residue until an
// already proven saved wallet migrates it.

import {isWalletOwnerId} from './walletOwner'
import {savedKeyOwnerAllows} from './currentOwner'

const NWC_ENABLED_STORAGE_KEY = 'sattle_nwc_enabled'
const NWC_ENABLED_VERSION = 1

type NwcEnabledRecord = {
  version: typeof NWC_ENABLED_VERSION
  ownerId: string
  enabled: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readNwcEnabledRecord = (): NwcEnabledRecord | null => {
  const raw = localStorage.getItem(NWC_ENABLED_STORAGE_KEY)
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      !isRecord(parsed) ||
      parsed.version !== NWC_ENABLED_VERSION ||
      !isWalletOwnerId(parsed.ownerId) ||
      typeof parsed.enabled !== 'boolean'
    ) {
      return null
    }
    return {
      version: NWC_ENABLED_VERSION,
      ownerId: parsed.ownerId,
      enabled: parsed.enabled,
    }
  } catch {
    return null
  }
}

export const readNwcEnabled = (ownerId: unknown): boolean => {
  if (!isWalletOwnerId(ownerId)) return false
  const record = readNwcEnabledRecord()
  return record?.ownerId === ownerId && record.enabled
}

export const writeNwcEnabled = (ownerId: unknown, enabled: boolean): void => {
  if (!isWalletOwnerId(ownerId) || !savedKeyOwnerAllows(ownerId)) {
    throw new Error('NWC enabled state requires a valid wallet owner.')
  }
  localStorage.setItem(
    NWC_ENABLED_STORAGE_KEY,
    JSON.stringify({version: NWC_ENABLED_VERSION, ownerId, enabled}),
  )
}

// the pre-owner storage form was a bare 'true'/'false' string - returns it
// when present so legacy migration can re-home the value under the proven
// owner, null for anything else (absent, junk, or an owned envelope)
export const readLegacyNwcEnabled = (): boolean | null => {
  const raw = localStorage.getItem(NWC_ENABLED_STORAGE_KEY)
  if (raw === 'true') return true
  if (raw === 'false') return false
  return null
}

// teardown of one owner's enabled state - any other owner's record (or a
// legacy string) is left exactly as found
export const clearNwcEnabledForOwner = (ownerId: unknown): void => {
  if (!isWalletOwnerId(ownerId)) return
  if (readNwcEnabledRecord()?.ownerId === ownerId) {
    localStorage.removeItem(NWC_ENABLED_STORAGE_KEY)
  }
}

// install-time residue sweep: only the legacy string form is unowned; an
// owned envelope stays (it is inert for every other owner)
export const clearUnownedNwcEnabled = (): void => {
  if (readLegacyNwcEnabled() !== null) {
    localStorage.removeItem(NWC_ENABLED_STORAGE_KEY)
  }
}
