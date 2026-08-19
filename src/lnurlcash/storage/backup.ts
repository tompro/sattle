// Backup files: everything exactly as it sits in localStorage - bearer
// ciphertexts always, the linking-key record only when it is itself
// password-encrypted. A plaintext linking key never leaves the device in a
// backup; the seed phrase is the recovery path for it instead. Trusted
// mints are plain (not secret - a mintPubkey is public), included as-is.

import type {StoredSecret} from '../keys'
import {
  getSavedLinkingKeyStored,
  savedKeyExists,
  savedKeyIsEncrypted,
  restoreLinkingKeyStored,
  isValidStoredSecret
} from '../keys'
import type {TrustedMint} from '../trustedMints'
import {readTrustedMints, mergeTrustedMints} from '../trustedMints'
import type {EncryptedBearerRecord} from './bearers'
import {readEncryptedBearers, writeEncryptedBearers} from './bearers'
import type {WalletSettings} from './settings'
import {loadSettings, persistSettings} from './settings'

export type BackupFile = {
  type: 'sattle-backup'
  version: 1
  createdAt: number
  linkingKey?: StoredSecret
  bearers: EncryptedBearerRecord[]
  trustedMints?: TrustedMint[]
  settings?: WalletSettings
}

export const buildBackup = (): BackupFile => {
  const backup: BackupFile = {
    type: 'sattle-backup',
    version: 1,
    createdAt: Date.now(),
    bearers: readEncryptedBearers(),
    trustedMints: readTrustedMints(),
    settings: loadSettings()
  }
  const storedKey = getSavedLinkingKeyStored()
  if (savedKeyIsEncrypted() && storedKey) {
    backup.linkingKey = storedKey
  }
  return backup
}

export type RestoreResult = {
  added: number
  skipped: number
  linkingKeyRestored: boolean
  // true when the backup carried a linking key but this device already had
  // one, so it was deliberately NOT installed (see below) - distinct from
  // "no key in this backup at all". The bearer records above still merged
  // in regardless, but they were encrypted under the backup's own seed, not
  // whatever wallet is active on this device - unless that's the exact same
  // seed, they won't decrypt here, and the caller should say so rather than
  // let that read as a silent no-op.
  linkingKeySkipped: boolean
  trustedMintsAdded: number
  // true when the backup's settings filled in a field this device had never
  // set - never when it would overwrite one, same merge direction as the
  // trusted mints (the device's own current state always wins)
  settingsRestored: boolean
}

// restore-time bounds - a crafted or corrupt file must not be able to fill
// localStorage with junk records that never decrypt (quota exhaustion turns
// every later write into a failure, which can strand a just-rotated note),
// nor hang the tab in JSON.parse. A real backup holds a handful of notes,
// each well under a kilobyte encrypted, so these are generous
export const MAX_BACKUP_FILE_BYTES = 10 * 1024 * 1024
const MAX_BACKUP_RECORDS = 10_000
const MAX_BACKUP_FIELD_LENGTH = 64 * 1024

const isBackupFile = (data: unknown): data is BackupFile => {
  if (typeof data !== 'object' || data === null) return false
  const backup = data as Record<string, unknown>
  return (
    backup.type === 'sattle-backup' &&
    backup.version === 1 &&
    Array.isArray(backup.bearers)
  )
}

// merges a backup into localStorage: bearer records are added by id
// (already present ids are left as-is - union, never overwrite), the
// backup's linking key is only installed when this device has none yet -
// never overwriting an existing wallet. That guard is deliberate (a
// stale/wrong backup must never clobber a wallet already holding funds),
// but it means restore order matters: a device that already has ANY wallet
// silently keeps its own key, and this backup's bearers merge into storage
// without ever becoming visible, since they don't decrypt under a
// different key. See linkingKeySkipped above. The note-level dedupe (same
// note arriving under a different record id, spent-wins) happens after
// decrypt, in bearers.ts's mergeBearers.
export const applyBackup = (data: unknown): RestoreResult => {
  if (!isBackupFile(data)) {
    throw new Error('Not a valid sattle backup file.')
  }
  const backup = data
  const existing = readEncryptedBearers()
  const existingIds = new Set(existing.map(r => r.id))
  if (backup.bearers.length > MAX_BACKUP_RECORDS) {
    throw new Error(
      `Backup holds ${backup.bearers.length} records - more than the ${MAX_BACKUP_RECORDS} a real wallet could produce.`
    )
  }
  let added = 0
  let skipped = 0
  for (const record of backup.bearers) {
    if (
      typeof record?.id !== 'string' ||
      typeof record?.iv !== 'string' ||
      typeof record?.ciphertext !== 'string' ||
      record.id.length > MAX_BACKUP_FIELD_LENGTH ||
      record.iv.length > MAX_BACKUP_FIELD_LENGTH ||
      record.ciphertext.length > MAX_BACKUP_FIELD_LENGTH
    ) {
      skipped++
      continue
    }
    if (existingIds.has(record.id)) {
      skipped++
      continue
    }
    existing.push({id: record.id, iv: record.iv, ciphertext: record.ciphertext})
    existingIds.add(record.id)
    added++
  }
  try {
    writeEncryptedBearers(existing)
  } catch {
    throw new Error(
      'Local storage is full - the backup could not be written. Free up space (or forget unused wallets) and try again.'
    )
  }

  let linkingKeyRestored = false
  let linkingKeySkipped = false
  // an invalid key record reads as "no key in this backup", never as skipped
  if (backup.linkingKey && isValidStoredSecret(backup.linkingKey)) {
    if (savedKeyExists()) {
      linkingKeySkipped = true
    } else {
      restoreLinkingKeyStored(backup.linkingKey)
      linkingKeyRestored = true
    }
  }

  const trustedMintsAdded = Array.isArray(backup.trustedMints)
    ? mergeTrustedMints(backup.trustedMints)
    : 0

  // settings merge: fill only fields this device has never set. Flat
  // optional fields (see settings.ts), so the merge is field by field -
  // today that is just defaultMint
  let settingsRestored = false
  if (typeof backup.settings === 'object' && backup.settings !== null) {
    const incoming = (backup.settings as Record<string, unknown>).defaultMint
    const local = loadSettings()
    if (
      local.defaultMint === undefined &&
      typeof incoming === 'string' &&
      incoming.length <= MAX_BACKUP_FIELD_LENGTH
    ) {
      persistSettings({...local, defaultMint: incoming})
      settingsRestored = true
    }
  }

  return {
    added,
    skipped,
    linkingKeyRestored,
    linkingKeySkipped,
    trustedMintsAdded,
    settingsRestored
  }
}
