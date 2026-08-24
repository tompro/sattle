// NWC connection persistence. Each record and the service-enabled setting
// belong to one canonical wallet owner, so local residue from another wallet
// is never served, edited, revoked, or charged. Hostile localStorage input is
// parsed before use; ownerless v0 records remain hidden until an already
// proven saved wallet explicitly migrates them.

import {linkingPubKeyHex, savedKeyOwnerId} from '../keys'
import {
  clearNwcEnabledForOwner,
  clearUnownedNwcEnabled,
  readLegacyNwcEnabled,
  writeNwcEnabled,
} from './nwcEnabled'
import {savedKeyOwnerAllows} from './currentOwner'
import {isWalletOwnerId} from './walletOwner'

export type NwcBudget = {
  maxMsat: number
  periodMs: number
}

export type NwcBudgetSpend = {
  periodStart: number
  msat: number
}

const NWC_RECORD_VERSION = 1

export type NwcConnectionRecord = {
  version: typeof NWC_RECORD_VERSION
  ownerId: string
  clientPubkey: string
  relays: string[]
  budget: NwcBudget
  spent: NwcBudgetSpend
  createdAt: number
}

type LegacyNwcConnectionRecord = Omit<NwcConnectionRecord, 'version' | 'ownerId'>

type StoredNwcConnection =
  {kind: 'owned'; record: NwcConnectionRecord} | {kind: 'legacy'; record: LegacyNwcConnectionRecord}

const NWC_CONNECTIONS_STORAGE_KEY = 'sattle_nwc_connections'

const HEX_64 = /^[0-9a-f]{64}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isRelay = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'wss:' || url.protocol === 'ws:'
  } catch {
    return false
  }
}

const parseStoredConnection = (value: unknown): StoredNwcConnection | null => {
  if (!isRecord(value)) return null
  const {clientPubkey, relays, budget, spent, createdAt} = value
  if (
    typeof clientPubkey !== 'string' ||
    !HEX_64.test(clientPubkey) ||
    !Array.isArray(relays) ||
    relays.length === 0 ||
    !relays.every(isRelay) ||
    !isRecord(budget) ||
    !isPositiveInteger(budget.maxMsat) ||
    !isPositiveInteger(budget.periodMs) ||
    !isRecord(spent) ||
    !isNonNegativeInteger(spent.periodStart) ||
    !isNonNegativeInteger(spent.msat) ||
    !isNonNegativeInteger(createdAt)
  ) {
    return null
  }
  const base: LegacyNwcConnectionRecord = {
    clientPubkey,
    relays,
    budget: {maxMsat: budget.maxMsat, periodMs: budget.periodMs},
    spent: {periodStart: spent.periodStart, msat: spent.msat},
    createdAt,
  }
  if (!Object.hasOwn(value, 'version') && !Object.hasOwn(value, 'ownerId')) {
    return {kind: 'legacy', record: base}
  }
  if (value.version !== NWC_RECORD_VERSION || !isWalletOwnerId(value.ownerId)) {
    return null
  }
  return {
    kind: 'owned',
    record: {...base, version: NWC_RECORD_VERSION, ownerId: value.ownerId},
  }
}

const readStoredConnections = (): StoredNwcConnection[] => {
  const raw = localStorage.getItem(NWC_CONNECTIONS_STORAGE_KEY)
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(parseStoredConnection)
      .filter((entry): entry is StoredNwcConnection => entry !== null)
  } catch {
    return []
  }
}

const storedValue = (entry: StoredNwcConnection): NwcConnectionRecord | LegacyNwcConnectionRecord =>
  entry.record

export const readNwcConnections = (ownerId: unknown): NwcConnectionRecord[] => {
  if (!isWalletOwnerId(ownerId)) return []
  return readStoredConnections()
    .filter(
      (entry): entry is Extract<StoredNwcConnection, {kind: 'owned'}> =>
        entry.kind === 'owned' && entry.record.ownerId === ownerId,
    )
    .map((entry) => entry.record)
}

export const writeNwcConnections = (ownerId: unknown, records: NwcConnectionRecord[]): void => {
  if (!isWalletOwnerId(ownerId) || !savedKeyOwnerAllows(ownerId)) {
    throw new Error('NWC connections require a valid wallet owner.')
  }
  const canonical: NwcConnectionRecord[] = []
  for (const record of records) {
    const parsed = parseStoredConnection(record)
    if (parsed?.kind !== 'owned' || parsed.record.ownerId !== ownerId) {
      throw new Error('Refusing to write an invalid or foreign NWC connection.')
    }
    canonical.push(parsed.record)
  }
  const preserved = readStoredConnections()
    .filter((entry) => entry.kind === 'legacy' || entry.record.ownerId !== ownerId)
    .map(storedValue)
  localStorage.setItem(NWC_CONNECTIONS_STORAGE_KEY, JSON.stringify([...preserved, ...canonical]))
}

export const persistNwcConnection = (
  ownerId: unknown,
  record: NwcConnectionRecord,
): NwcConnectionRecord => {
  if (!isWalletOwnerId(ownerId) || record.ownerId !== ownerId) {
    throw new Error('NWC connection writes require a valid wallet owner.')
  }
  const records = readNwcConnections(ownerId)
  const index = records.findIndex((stored) => stored.clientPubkey === record.clientPubkey)
  if (index >= 0) records[index] = record
  else records.push(record)
  writeNwcConnections(ownerId, records)
  return record
}

export const removeNwcConnection = (ownerId: unknown, clientPubkey: string): void => {
  if (!isWalletOwnerId(ownerId)) return
  writeNwcConnections(
    ownerId,
    readNwcConnections(ownerId).filter((record) => record.clientPubkey !== clientPubkey),
  )
}

export type NwcLegacyMigrationResult = {
  connections: number
  enabled: boolean
}

export const migrateLegacyNwcStorage = (linkingKey: Uint8Array): NwcLegacyMigrationResult => {
  const ownerId = linkingPubKeyHex(linkingKey)
  if (savedKeyOwnerId() !== ownerId) {
    throw new Error('Legacy NWC migration requires a proven saved wallet owner.')
  }

  const stored = readStoredConnections()
  let connections = 0
  const migrated = stored.map((entry) => {
    if (entry.kind === 'owned') return entry.record
    connections += 1
    return {
      ...entry.record,
      version: NWC_RECORD_VERSION,
      ownerId,
    } satisfies NwcConnectionRecord
  })
  if (connections > 0) {
    localStorage.setItem(NWC_CONNECTIONS_STORAGE_KEY, JSON.stringify(migrated))
  }

  const legacyEnabled = readLegacyNwcEnabled()
  if (legacyEnabled !== null) writeNwcEnabled(ownerId, legacyEnabled)
  return {connections, enabled: legacyEnabled !== null}
}

const persistStoredConnections = (entries: StoredNwcConnection[]): void => {
  if (entries.length === 0) {
    localStorage.removeItem(NWC_CONNECTIONS_STORAGE_KEY)
    return
  }
  localStorage.setItem(NWC_CONNECTIONS_STORAGE_KEY, JSON.stringify(entries.map(storedValue)))
}

export const clearNwcStorageForOwner = (ownerId: unknown): void => {
  if (!isWalletOwnerId(ownerId) || !savedKeyOwnerAllows(ownerId)) {
    throw new Error('NWC teardown requires a valid wallet owner.')
  }
  persistStoredConnections(
    readStoredConnections().filter(
      (entry) => entry.kind === 'legacy' || entry.record.ownerId !== ownerId,
    ),
  )
  clearNwcEnabledForOwner(ownerId)
}

export const clearUnownedNwcStorage = (): void => {
  persistStoredConnections(readStoredConnections().filter((entry) => entry.kind === 'owned'))
  clearUnownedNwcEnabled()
}
