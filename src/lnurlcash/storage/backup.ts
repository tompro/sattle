// Backup files: everything exactly as it sits in localStorage - bearer
// ciphertexts and the BIP-32 counter map always, the linking-key record only
// when it is itself password-encrypted. A plaintext linking key never leaves
// the device in a backup; the seed phrase is the recovery path for it
// instead. Trusted mints are plain (not secret - a mintPubkey is public),
// included as-is. The pending-mutation journal is device-local recovery
// state and is deliberately NOT part of any backup.
//
// Format v2 (breaking): the funds document made bearers + counters one
// atomic unit, so the backup projects both from the same single read -
// they can never disagree about which generation they came from.

import type {StoredSecret} from '../keys'
import {
  getSavedLinkingKeyStored,
  savedKeyExists,
  savedKeyIsEncrypted,
  restoreLinkingKeyStored,
  isValidStoredSecret,
} from '../keys'
import type {TrustedMint} from '../trustedMints'
import {readTrustedMints, mergeTrustedMints} from '../trustedMints'
import {isWalletOwnerId} from './walletOwner'
import type {EncryptedBearerRecord} from './bearers'
import {commitFundsRestore, readFundsDocument} from './bearers'
import type {WalletSettings} from './settings'
import {loadSettings, persistSettings} from './settings'
import {isJsonObject} from '../jsonParsing'

export type BackupFile = {
  type: 'sattle-backup'
  version: 2
  createdAt: number
  ownerId?: unknown
  linkingKey?: StoredSecret
  bearers: EncryptedBearerRecord[]
  nextByHost: Record<string, number>
  trustedMints?: TrustedMint[]
  settings?: WalletSettings
}

type ParsedBackupFile = {
  type: 'sattle-backup'
  version: 2
  createdAt?: unknown
  ownerId?: unknown
  linkingKey?: unknown
  bearers: unknown[]
  nextByHost: Record<string, unknown>
  trustedMints?: unknown
  settings?: unknown
}

export const buildBackup = (ownerId?: string): BackupFile => {
  // one document, one getItem: bearers and counters are snapshot-consistent
  // by construction; pending journal records are never read here
  const funds = readFundsDocument()
  const backup: BackupFile = {
    type: 'sattle-backup',
    version: 2,
    createdAt: Date.now(),
    bearers: funds.bearers,
    nextByHost: funds.nextByHost,
    trustedMints: readTrustedMints(ownerId),
    settings: loadSettings(),
  }
  if (isWalletOwnerId(ownerId)) backup.ownerId = ownerId
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

const isBackupFile = (data: unknown): data is ParsedBackupFile =>
  isJsonObject(data) &&
  data.type === 'sattle-backup' &&
  data.version === 2 &&
  Array.isArray(data.bearers) &&
  isJsonObject(data.nextByHost)

export const parseBackupFile = (data: unknown): ParsedBackupFile => {
  if (!isBackupFile(data)) {
    throw new Error('Not a valid sattle backup file.')
  }
  return data
}

// merges a backup into localStorage: bearer records are added by id
// (already present ids are left as-is - union, never overwrite) and counter
// entries merge upward-only (max per host - a stale backup must never rewind
// a BIP-32 counter and reopen burned indices), both inside ONE locked funds
// document write (commitFundsRestore enforces the counter bounds). The
// backup's linking key is only installed when this device has none yet -
// never overwriting an existing wallet. That guard is deliberate (a
// stale/wrong backup must never clobber a wallet already holding funds),
// but it means restore order matters: a device that already has ANY wallet
// silently keeps its own key, and this backup's bearers merge into storage
// without ever becoming visible, since they don't decrypt under a
// different key. See linkingKeySkipped above. The note-level dedupe (same
// note arriving under a different record id, spent-wins) happens after
// decrypt, in bearers.ts's mergeBearers.
export const applyBackup = async (data: unknown, ownerId?: string): Promise<RestoreResult> => {
  const backup = parseBackupFile(data)
  if (backup.bearers.length > MAX_BACKUP_RECORDS) {
    throw new Error(
      `Backup holds ${backup.bearers.length} records - more than the ${MAX_BACKUP_RECORDS} a real wallet could produce.`,
    )
  }
  const incomingBearers: EncryptedBearerRecord[] = []
  let skipped = 0
  for (const record of backup.bearers) {
    if (
      !isJsonObject(record) ||
      typeof record.id !== 'string' ||
      typeof record.iv !== 'string' ||
      typeof record.ciphertext !== 'string' ||
      record.id.length > MAX_BACKUP_FIELD_LENGTH ||
      record.iv.length > MAX_BACKUP_FIELD_LENGTH ||
      record.ciphertext.length > MAX_BACKUP_FIELD_LENGTH
    ) {
      skipped++
      continue
    }
    incomingBearers.push({id: record.id, iv: record.iv, ciphertext: record.ciphertext})
  }
  // candidate counters: validity (host length, safe range, host cap) is
  // enforced by commitFundsRestore; here we only keep the raw shape honest
  const incomingCounters: Record<string, number> = {}
  for (const [host, next] of Object.entries(backup.nextByHost)) {
    if (typeof next === 'number') incomingCounters[host] = next
  }

  let added: number
  try {
    const merged = await commitFundsRestore(incomingBearers, incomingCounters)
    added = merged.added
    skipped += merged.skipped
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    const message = error instanceof Error ? error.message : ''
    if (name === 'QuotaExceededError' || /quota|full/i.test(message)) {
      throw new Error(
        'Local storage is full - the backup could not be written. Free up space (or forget unused wallets) and try again.',
        {cause: error},
      )
    }
    throw error
  }

  let linkingKeyRestored = false
  let linkingKeySkipped = false
  // an invalid key record reads as "no key in this backup", never as skipped
  if (isValidStoredSecret(backup.linkingKey)) {
    if (savedKeyExists()) {
      linkingKeySkipped = true
    } else {
      restoreLinkingKeyStored(backup.linkingKey)
      linkingKeyRestored = true
    }
  }

  // A file-carried owner marker is not identity proof, so it cannot namespace
  // imported trust. Fresh file restores drop pins until key proof; active-wallet
  // and Nostr restores supply an owner derived from their already-proven key.
  const trustedMintsAdded =
    ownerId && Array.isArray(backup.trustedMints)
      ? await mergeTrustedMints(backup.trustedMints, ownerId)
      : 0

  // settings merge: fill only fields this device has never set. Flat
  // optional fields (see settings.ts), so the merge is field by field -
  // today that is just defaultMint
  let settingsRestored = false
  if (isJsonObject(backup.settings)) {
    const incoming = backup.settings.defaultMint
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
    settingsRestored,
  }
}
