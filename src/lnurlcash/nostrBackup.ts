// Nostr backup: the wallet's bearer store, trusted-mint registry and
// settings mirrored onto public relays as addressable events (kind 30078,
// the NIP-78 app-data range), every payload NIP-44 v2 encrypted to the
// backup key's own pubkey - only the seed holder can read them, and the
// seed phrase alone (via keys.ts's linking key) re-derives everything.
//
// Framework-free, and no WebSocket is touched at import time: the default
// transport (nostr-tools' SimplePool) is imported lazily on first use, and
// tests inject a fake transport instead.
//
// Split by concern; this façade re-exports everything:
//   nostr/events.ts     - backup-key derivation + the event codec
//                         (build/sign, verify/decrypt), no I/O
//   nostr/transport.ts  - the injectable relay transport (SimplePool by
//                         default, lazily imported)
//   nostr/sync.ts       - publishBackup / fetchBackup / restoreFromNostr
//   nostr/publisher.ts  - the debounced publisher for store change events

export {
  BACKUP_EVENT_KIND,
  BACKUP_PARTS,
  BACKUP_D_TAGS,
  deriveBackupKey,
  backupPubkey,
  buildBackupEvent,
  buildBackupEvents,
  parseBackupEvent
} from './nostr/events'
export type {
  NostrEvent,
  BackupPart,
  BackupPartPayload,
  ParsedBackupEvent
} from './nostr/events'

export type {BackupTransport, NostrFilter} from './nostr/transport'

export {publishBackup, fetchBackup, restoreFromNostr} from './nostr/sync'
export type {
  PublishBackupOptions,
  PublishBackupResult,
  FetchBackupOptions,
  NostrRestoreResult
} from './nostr/sync'

export {createBackupPublisher} from './nostr/publisher'
export type {BackupPublisher, BackupPublisherOptions} from './nostr/publisher'
