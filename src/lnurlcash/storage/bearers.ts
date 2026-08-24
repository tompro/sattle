// Encrypted bearer-note persistence: each note is an AES-GCM ciphertext
// record under a key derived from the linking key (see keys.ts), so a note
// URL - which IS the money - never touches disk in plaintext.

import type {EncryptedRecordParts} from '../keys'
import {encryptRecord, decryptRecord} from '../keys'
import type {Bearer, NewBearer} from '../types'
import {isJsonObject} from '../jsonParsing'
import {noteK1, serverOf} from 'lnurlcash-kit'
import {withStorageLock} from '../storageLock'

// the wallet's default note order (newest first) with manually dragged
// notes taking priority once they have an explicit rank
export const compareBearerOrder = (a: Bearer, b: Bearer): number =>
  (a.sortIndex ?? -a.createdAt) - (b.sortIndex ?? -b.createdAt)

export type EncryptedBearerRecord = {id: string} & EncryptedRecordParts

const isEncryptedBearerRecord = (value: unknown): value is EncryptedBearerRecord =>
  isJsonObject(value) &&
  typeof value.id === 'string' &&
  typeof value.iv === 'string' &&
  typeof value.ciphertext === 'string'

const isStoredBearer = (value: unknown): value is Omit<Bearer, 'id'> =>
  isJsonObject(value) &&
  typeof value.url === 'string' &&
  typeof value.callback === 'string' &&
  typeof value.amount === 'number' &&
  typeof value.verified === 'boolean' &&
  typeof value.createdAt === 'number' &&
  typeof value.updatedAt === 'number' &&
  (value.mintPubkey === undefined || typeof value.mintPubkey === 'string') &&
  (value.spent === undefined || typeof value.spent === 'boolean') &&
  (value.sortIndex === undefined || typeof value.sortIndex === 'number') &&
  (value.label === undefined || typeof value.label === 'string') &&
  (value.deviceId === undefined || typeof value.deviceId === 'string')

const BEARERS_STORAGE_KEY = 'sattle_bearers'

export const newBearerId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

export const readEncryptedBearers = (): EncryptedBearerRecord[] => {
  const raw = localStorage.getItem(BEARERS_STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isEncryptedBearerRecord) : []
  } catch {
    return []
  }
}

export const writeEncryptedBearers = (records: EncryptedBearerRecord[]): void => {
  localStorage.setItem(BEARERS_STORAGE_KEY, JSON.stringify(records))
}

type BearerCommitOptions = {beforeCommit?: () => void}

// decrypts everything currently stored - a record that fails to decrypt
// (e.g. written by a different seed's key) is skipped, not destroyed: it
// stays in localStorage untouched and simply doesn't show up
export const loadBearers = async (aesKey: CryptoKey): Promise<Bearer[]> => {
  const bearers: Bearer[] = []
  for (const record of readEncryptedBearers()) {
    try {
      const bearer = await decryptRecord(aesKey, record)
      if (!isStoredBearer(bearer)) throw new Error('Malformed encrypted bearer record.')
      bearers.push({...bearer, id: record.id})
    } catch (error) {
      // undecryptable with this key - leave it in place
      if (!(error instanceof Error)) throw error
    }
  }
  return bearers.sort((a, b) => b.createdAt - a.createdAt)
}

export const persistBearer = async (
  aesKey: CryptoKey,
  bearer: Bearer,
  options: BearerCommitOptions = {},
): Promise<void> => {
  const {id, ...plain} = bearer
  const parts = await encryptRecord(aesKey, plain)
  await withStorageLock(BEARERS_STORAGE_KEY, () => {
    options.beforeCommit?.()
    const records = readEncryptedBearers().filter((r) => r.id !== id)
    records.push({id, ...parts})
    writeEncryptedBearers(records)
  })
}

export const deleteBearerRecord = async (
  id: string,
  options: BearerCommitOptions = {},
): Promise<void> => {
  await withStorageLock(BEARERS_STORAGE_KEY, () => {
    options.beforeCommit?.()
    writeEncryptedBearers(readEncryptedBearers().filter((r) => r.id !== id))
  })
}

// The atomic unit of bearer persistence: fresh notes to start tracking plus
// ids of snapshot notes to lock as spent. Born-spent notes (carved and
// melted away in one flow) are deliberately not representable - they were
// never the wallet's money in a trackable state.
export type BearerChangeset = {
  add: NewBearer[]
  markSpent: string[]
  upsert?: Bearer[]
  remove?: string[]
}

// Commits a whole changeset as ONE storage write - the fund-critical
// boundary a caller (NWC service, wallet store) awaits before reporting
// success. The per-record path above (persistBearer in a loop) can die
// halfway through a melt: some records persisted, some not, while the
// caller's reactive state already moved on. Here nothing becomes
// observable until the single locked write lands:
//
// - every changed Bearer value is derived from the caller's snapshot: added
//   notes get their id/timestamps assigned HERE (so state and storage can
//   never disagree about them), spent marks copy the snapshot's record
// - ALL encryption happens BEFORE the lock is taken - crypto is the slow,
//   async part and a storage lock must never be held across it (see
//   storageLock.ts); if any record fails to encrypt, no write happens at
//   all
// - inside the lock the encrypted records are re-read FRESH, so records
//   another tab committed after the caller's snapshot survive the upsert -
//   changed ids replace their stored copy, everything else is kept as-is
//   (unrelated records are never decrypted or re-encrypted)
// - markSpent ids absent from the snapshot are ignored: deriving them would
//   require decrypting a record the caller doesn't hold
// - a changeset that changes nothing performs no write at all
// - caller arrays are never mutated
// - options.beforeCommit runs synchronously INSIDE the lock, immediately
//   before the single write: the caller's last-chance fence (the wallet
//   store revalidates persisted ownership there). Throwing aborts the
//   commit with storage untouched. Four parameters are deliberate here:
//   the fence is an orthogonal hook, not changeset data, and grouping it
//   into the changeset would let callers persist it by accident.
//
// Returns the next local bearer list (additions first, then the snapshot
// with spent marks applied) only after the write succeeded; on any failure
// the promise rejects and persisted state is untouched.
export const applyBearerChangeset = async (
  aesKey: CryptoKey,
  snapshot: Bearer[],
  changeset: BearerChangeset,
  options: BearerCommitOptions = {},
): Promise<Bearer[]> => {
  const now = Date.now()
  const added: Bearer[] = changeset.add.map((note) => ({
    id: newBearerId(),
    ...note,
    createdAt: now,
    updatedAt: now,
  }))
  const spentIds = new Set(changeset.markSpent)
  const spent = new Map<string, Bearer>()
  for (const bearer of snapshot) {
    if (spentIds.has(bearer.id)) {
      spent.set(bearer.id, {...bearer, spent: true, updatedAt: now})
    }
  }
  const upserted = changeset.upsert ?? []
  const removedIds = new Set(changeset.remove ?? [])
  const changedById = new Map<string, Bearer>()
  for (const bearer of spent.values()) changedById.set(bearer.id, bearer)
  for (const bearer of upserted) changedById.set(bearer.id, bearer)
  for (const bearer of added) changedById.set(bearer.id, bearer)
  const changed = [...changedById.values()]
  if (changed.length === 0 && removedIds.size === 0) return snapshot
  const encrypted: EncryptedBearerRecord[] = []
  for (const bearer of changed) {
    const {id, ...plain} = bearer
    const parts = await encryptRecord(aesKey, plain)
    encrypted.push({id, ...parts})
  }
  await withStorageLock(BEARERS_STORAGE_KEY, () => {
    options.beforeCommit?.()
    const changedIds = new Set(encrypted.map((r) => r.id))
    const records = readEncryptedBearers().filter(
      (record) => !changedIds.has(record.id) && !removedIds.has(record.id),
    )
    records.push(...encrypted)
    writeEncryptedBearers(records)
  })
  const snapshotIds = new Set(snapshot.map((bearer) => bearer.id))
  const inserted = upserted.filter((bearer) => !snapshotIds.has(bearer.id))
  const retained = snapshot
    .filter((bearer) => !removedIds.has(bearer.id))
    .map((bearer) => changedById.get(bearer.id) ?? bearer)
  return [...added, ...inserted, ...retained]
}

// wipes every bearer record from this device outright - unlike forgetting
// just the linking key, this is not recoverable by restoring the same seed:
// the ciphertexts themselves are gone, so only a previously downloaded
// backup file can bring them back
export const clearAllBearers = (): void => {
  localStorage.removeItem(BEARERS_STORAGE_KEY)
}

// Merge two decrypted bearer lists into one, keyed by note identity
// (issuing server + k1 secret), falling back to record id for notes whose
// k1 is absent (a paired-device mirror carries none). Union semantics with
// spent-wins: when both lists hold the same note, the copy locked as spent
// always survives over a still-spendable one - a spent note that "comes
// back" after a restore is how double-spends are born. Among copies in the
// same spent state, the newer updatedAt wins. This is the merge a restore
// (backup file now, nostr later) applies after its records decrypt, and it
// is what makes multi-device restores converge instead of duplicate.
export const mergeBearers = (current: Bearer[], incoming: Bearer[]): Bearer[] => {
  const keyOf = (b: Bearer): string => {
    const k1 = noteK1(b.url)
    return k1 ? `${serverOf(b.url)}#${k1}` : `id#${b.id}`
  }
  const merged = new Map<string, Bearer>()
  for (const bearer of [...current, ...incoming]) {
    const key = keyOf(bearer)
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, bearer)
      continue
    }
    if (bearer.spent !== existing.spent) {
      merged.set(key, bearer.spent ? bearer : existing)
      continue
    }
    merged.set(key, bearer.updatedAt >= existing.updatedAt ? bearer : existing)
  }
  return [...merged.values()].sort((a, b) => b.createdAt - a.createdAt)
}
