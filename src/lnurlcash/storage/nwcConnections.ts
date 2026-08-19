// NWC connection persistence: one localStorage record holding every NIP-47
// connection this wallet serves (see nwc.ts). A record is public metadata
// only - the wallet-service key is re-derived from the linking key and the
// client pubkey (nwc/connection.ts's deriveNwcWalletKey), and the CLIENT
// secret is never stored at all (NIP-47: the wallet service should not
// store the secret it generates for the client). The budget spend counter
// lives here so a restart doesn't reset a client's allowance.

export type NwcBudget = {
  // the most this connection may pay per period, msat
  maxMsat: number
  // the period length in milliseconds (e.g. 86_400_000 for daily)
  periodMs: number
}

// spend within the current period; rolls over once periodStart is more
// than budget.periodMs in the past
export type NwcBudgetSpend = {
  periodStart: number
  msat: number
}

export type NwcConnectionRecord = {
  // the authorized client's pubkey (the pubkey of the client secret that
  // was handed out in the connection string, once, at creation time)
  clientPubkey: string
  relays: string[]
  budget: NwcBudget
  spent: NwcBudgetSpend
  createdAt: number
}

const NWC_CONNECTIONS_STORAGE_KEY = 'sattle_nwc_connections'

const HEX_64 = /^[0-9a-f]{64}$/i

// strict shape check, same spirit as passkeySlots.ts: localStorage content
// is not trustworthy input, so records are validated before use
const isValidNwcConnectionRecord = (
  record: unknown
): record is NwcConnectionRecord => {
  if (typeof record !== 'object' || record === null) return false
  const r = record as Record<string, unknown>
  const budget = r.budget as Record<string, unknown> | null
  const spent = r.spent as Record<string, unknown> | null
  return (
    typeof r.clientPubkey === 'string' &&
    HEX_64.test(r.clientPubkey) &&
    Array.isArray(r.relays) &&
    r.relays.length > 0 &&
    r.relays.every(
      relay => typeof relay === 'string' && /^wss?:\/\//.test(relay)
    ) &&
    typeof budget === 'object' &&
    budget !== null &&
    typeof budget.maxMsat === 'number' &&
    Number.isInteger(budget.maxMsat) &&
    budget.maxMsat > 0 &&
    typeof budget.periodMs === 'number' &&
    budget.periodMs > 0 &&
    typeof spent === 'object' &&
    spent !== null &&
    typeof spent.periodStart === 'number' &&
    typeof spent.msat === 'number' &&
    spent.msat >= 0 &&
    typeof r.createdAt === 'number'
  )
}

// malformed entries are dropped, not thrown on - one corrupted record must
// not take the remaining connections down with it
export const readNwcConnections = (): NwcConnectionRecord[] => {
  const raw = localStorage.getItem(NWC_CONNECTIONS_STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter(isValidNwcConnectionRecord)
      : []
  } catch {
    return []
  }
}

export const writeNwcConnections = (
  records: NwcConnectionRecord[]
): void => {
  localStorage.setItem(NWC_CONNECTIONS_STORAGE_KEY, JSON.stringify(records))
}

// upsert by client pubkey; returns the stored record. Callers serialize
// read-modify-write cycles themselves (the NWC service serializes per
// connection through its request queue)
export const persistNwcConnection = (
  record: NwcConnectionRecord
): NwcConnectionRecord => {
  const records = readNwcConnections()
  const index = records.findIndex(r => r.clientPubkey === record.clientPubkey)
  if (index >= 0) records[index] = record
  else records.push(record)
  writeNwcConnections(records)
  return record
}

export const removeNwcConnection = (clientPubkey: string): void => {
  writeNwcConnections(
    readNwcConnections().filter(r => r.clientPubkey !== clientPubkey)
  )
}
