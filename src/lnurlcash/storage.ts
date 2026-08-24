// The storage layer's single import surface: encrypted persistence for
// bearer notes and the activity log (AES-GCM under a key derived from the
// linking key), plaintext registries for settings, and backup files. The
// trusted-mint registry is plaintext too but lives in trustedMints.ts -
// the Pinia mints store and this module's backup both use it.
//
// Split by concern; this façade re-exports everything:
//   storage/bearers.ts     - encrypted bearer records, changeset commits,
//                            mergeBearers
//   storage/activityLog.ts - the append-only encrypted activity log
//   storage/settings.ts    - plaintext wallet settings
//   storage/backup.ts      - buildBackup / applyBackup

export type {Bearer, NewBearer} from './types'

export {
  compareBearerOrder,
  newBearerId,
  readEncryptedBearers,
  loadBearers,
  persistBearer,
  deleteBearerRecord,
  applyBearerChangeset,
  clearAllBearers,
  mergeBearers,
} from './storage/bearers'
export type {BearerChangeset, EncryptedBearerRecord} from './storage/bearers'

export {
  newActivityId,
  readEncryptedActivity,
  loadActivity,
  persistActivityEvent,
  clearAllActivity,
  MAX_ACTIVITY_ENTRIES,
} from './storage/activityLog'
export type {ActivityKind, ActivityEvent, EncryptedActivityRecord} from './storage/activityLog'

export {loadSettings, persistSettings, clearSettings} from './storage/settings'
export type {WalletSettings} from './storage/settings'

export {buildBackup, applyBackup, parseBackupFile, MAX_BACKUP_FILE_BYTES} from './storage/backup'
export type {BackupFile, RestoreResult} from './storage/backup'
