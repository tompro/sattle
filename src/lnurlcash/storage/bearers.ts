// Encrypted bearer-note persistence: each note is an AES-GCM ciphertext
// record under a key derived from the linking key (see keys.ts), so a note
// URL - which IS the money - never touches disk in plaintext.

import type {EncryptedRecordParts} from '../keys'
import {encryptRecord, decryptRecord} from '../keys'
import type {Bearer} from '../types'
import {noteK1, serverOf} from 'lnurlcash-kit'
import {withStorageLock} from '../storageLock'

// the wallet's default note order (newest first) with manually dragged
// notes taking priority once they have an explicit rank
export const compareBearerOrder = (a: Bearer, b: Bearer): number =>
  (a.sortIndex ?? -a.createdAt) - (b.sortIndex ?? -b.createdAt)

export type EncryptedBearerRecord = {id: string} & EncryptedRecordParts

const BEARERS_STORAGE_KEY = 'sattle_bearers'

export const newBearerId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

export const readEncryptedBearers = (): EncryptedBearerRecord[] => {
  const raw = localStorage.getItem(BEARERS_STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export const writeEncryptedBearers = (
  records: EncryptedBearerRecord[]
): void => {
  localStorage.setItem(BEARERS_STORAGE_KEY, JSON.stringify(records))
}

// decrypts everything currently stored - a record that fails to decrypt
// (e.g. written by a different seed's key) is skipped, not destroyed: it
// stays in localStorage untouched and simply doesn't show up
export const loadBearers = async (aesKey: CryptoKey): Promise<Bearer[]> => {
  const bearers: Bearer[] = []
  for (const record of readEncryptedBearers()) {
    try {
      const bearer = await decryptRecord<Omit<Bearer, 'id'>>(aesKey, record)
      bearers.push({...bearer, id: record.id})
    } catch {
      // undecryptable with this key - leave it in place
    }
  }
  return bearers.sort((a, b) => b.createdAt - a.createdAt)
}

export const persistBearer = async (
  aesKey: CryptoKey,
  bearer: Bearer
): Promise<void> => {
  const {id, ...plain} = bearer
  const parts = await encryptRecord(aesKey, plain)
  await withStorageLock(BEARERS_STORAGE_KEY, () => {
    const records = readEncryptedBearers().filter(r => r.id !== id)
    records.push({id, ...parts})
    writeEncryptedBearers(records)
  })
}

export const deleteBearerRecord = async (id: string): Promise<void> => {
  await withStorageLock(BEARERS_STORAGE_KEY, () => {
    writeEncryptedBearers(readEncryptedBearers().filter(r => r.id !== id))
  })
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
export const mergeBearers = (
  current: Bearer[],
  incoming: Bearer[]
): Bearer[] => {
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
