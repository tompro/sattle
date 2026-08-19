// Publish / fetch / restore for nostr backup, over an injected transport.
//
// v1 is single-device last-writer-wins at the relay (addressable events
// replace). Restore merges locally through storage/backup.ts's applyBackup
// - the SAME entry point as file restore (union by record id, mints merged
// unconfirmed, settings fill-only) - so the two restore paths can't drift
// apart. The note-level dedupe (same note under different record ids,
// spent-wins) happens after decrypt in bearers.ts's mergeBearers, exactly
// as with a file backup.

import type {RestoreResult} from '../storage/backup'
import {applyBackup} from '../storage/backup'

import type {
  BackupPart,
  BackupPartPayload,
  NostrEvent
} from './events'
import {
  BACKUP_EVENT_KIND,
  BACKUP_PARTS,
  backupPubkey,
  buildBackupEvent,
  deriveBackupKey,
  dTagOf,
  parseBackupEvent
} from './events'
import type {BackupTransport} from './transport'
import {defaultTransport} from './transport'

export type PublishBackupOptions = {
  transport?: BackupTransport
  createdAt?: number
}

export type PublishBackupResult = {
  published: BackupPart[]
}

// builds and publishes one event per part present in `parts`
export const publishBackup = async (
  secretKey: Uint8Array,
  parts: Partial<BackupPartPayload>,
  relays: string[],
  options: PublishBackupOptions = {}
): Promise<PublishBackupResult> => {
  const at = options.createdAt ?? Math.floor(Date.now() / 1000)
  const present = BACKUP_PARTS.filter(part => parts[part] !== undefined)
  if (present.length === 0) return {published: []}
  const transport = options.transport ?? (await defaultTransport())
  const published: BackupPart[] = []
  for (const part of present) {
    const payload = parts[part]
    if (payload === undefined) continue
    await transport.publish(
      relays,
      buildBackupEvent(secretKey, part, payload, at)
    )
    published.push(part)
  }
  return {published}
}

export type FetchBackupOptions = {
  // the pubkey alone can fetch the ciphertext, but only the key holder
  // reads it - decryption is part of fetching
  secretKey: Uint8Array
  transport?: BackupTransport
}

// fetches the newest valid event per d-tag and decrypts it. Honest relays
// already replace addressable events, but a stale or misbehaving relay may
// serve older copies, so the newest is picked client-side; events that
// fail validation or decryption are skipped, not fatal.
export const fetchBackup = async (
  pubkey: string,
  relays: string[],
  options: FetchBackupOptions
): Promise<Partial<BackupPartPayload>> => {
  const transport = options.transport ?? (await defaultTransport())
  const events = await transport.fetch(relays, {
    kinds: [BACKUP_EVENT_KIND],
    authors: [pubkey]
  })
  const byTag = new Map<string, NostrEvent[]>()
  for (const event of events) {
    const d = dTagOf(event)
    if (!d) continue
    const candidates = byTag.get(d)
    if (candidates) candidates.push(event)
    else byTag.set(d, [event])
  }
  const parts: Partial<BackupPartPayload> = {}
  for (const candidates of byTag.values()) {
    // a hostile relay may serve a tampered "newest" copy - walk
    // newest-first and take the first that validates and decrypts
    candidates.sort((a, b) => b.created_at - a.created_at)
    for (const event of candidates) {
      const parsed = parseBackupEvent(options.secretKey, event)
      if (!parsed) continue
      switch (parsed.part) {
        case 'notes':
          parts.notes = parsed.bearers
          break
        case 'mints':
          parts.mints = parsed.trustedMints
          break
        case 'settings':
          parts.settings = parsed.settings
          break
      }
      break
    }
  }
  return parts
}

export type NostrRestoreResult = RestoreResult & {
  // which d-tags carried a valid payload at all - lets the caller
  // distinguish "nothing backed up yet" from "restored an empty wallet"
  found: BackupPart[]
}

// The restore path end to end: re-derive the backup key from the linking
// key (the holder already re-entered the seed phrase to get that far),
// fetch every part, and hand the lot to storage's applyBackup as an
// ordinary sattle backup - the same merge entry point as file restore, so
// union-by-id, mint trust rules and settings fill-only behave identically
// no matter where the backup came from.
export const restoreFromNostr = async (
  linkingPrivKey: Uint8Array,
  relays: string[],
  options: {transport?: BackupTransport} = {}
): Promise<NostrRestoreResult> => {
  const secretKey = deriveBackupKey(linkingPrivKey)
  const parts = await fetchBackup(backupPubkey(secretKey), relays, {
    secretKey,
    transport: options.transport
  })
  const result = applyBackup({
    type: 'sattle-backup',
    version: 1,
    createdAt: Date.now(),
    bearers: parts.notes ?? [],
    trustedMints: parts.mints,
    settings: parts.settings
  })
  return {
    ...result,
    found: BACKUP_PARTS.filter(part => parts[part] !== undefined)
  }
}
