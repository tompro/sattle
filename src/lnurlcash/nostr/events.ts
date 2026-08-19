// The pure half of nostr backup: backup-key derivation and the backup
// event codec - build, sign, verify, decrypt - with no relay I/O.
//
// The backup key is derived, not generated: sha256 over the linking key
// plus a fixed context string, the same construction as keys.ts's
// deriveBearerAesKey. The seed phrase itself is never stored, so the
// derivation starts from the linking key - deterministic all the way down,
// which is what makes restore-from-seed work on a fresh device.
//
// Three d-tags carry three payloads in separate replaceable slots, so a
// notes publish never clobbers settings:
//   notes    - the encrypted bearer records exactly as they sit in
//              localStorage (each note is already an AES-GCM ciphertext
//              under the seed-derived bearer key, so the blob goes up
//              as-is; the linking key itself is NEVER part of a payload -
//              the seed phrase is its recovery path)
//   mints    - the trusted-mint registry
//   settings - plaintext wallet settings

import {sha256} from '@noble/hashes/sha2.js'
import {utf8ToBytes} from '@noble/hashes/utils.js'
import type {Event as NostrEvent} from 'nostr-tools/core'
import {finalizeEvent, getPublicKey, verifyEvent} from 'nostr-tools/pure'
import {v2 as nip44v2} from 'nostr-tools/nip44'

import type {EncryptedBearerRecord} from '../storage/bearers'
import type {TrustedMint} from '../trustedMints'
import type {WalletSettings} from '../storage/settings'

export type {NostrEvent}

// addressable (parametrized-replaceable) app-data event - relays keep only
// the newest event per (pubkey, kind, d-tag)
export const BACKUP_EVENT_KIND = 30078

export type BackupPart = 'notes' | 'mints' | 'settings'

export const BACKUP_PARTS: readonly BackupPart[] = ['notes', 'mints', 'settings']

// the backup key is dedicated to this wallet (derived with a
// sattle-specific context, see below), so its pubkey is ours alone and the
// d-tags need no further namespacing
export const BACKUP_D_TAGS: Record<BackupPart, string> = {
  notes: 'notes',
  mints: 'mints',
  settings: 'settings'
}

// the decrypted payload of each part, without its envelope
export type BackupPartPayload = {
  notes: EncryptedBearerRecord[]
  mints: TrustedMint[]
  settings: WalletSettings
}

const BACKUP_KEY_CONTEXT = 'sattle-nostr-backup-v1'

// Deterministic: sha256(linking key || context), mirroring keys.ts's
// deriveBearerAesKey. The result is a secp256k1 secret key used ONLY for
// backup - it signs and decrypts backup events, nothing else.
export const deriveBackupKey = (linkingPrivKey: Uint8Array): Uint8Array =>
  sha256(new Uint8Array([...linkingPrivKey, ...utf8ToBytes(BACKUP_KEY_CONTEXT)]))

// the x-only nostr pubkey identifying this wallet's backup events
export const backupPubkey = (secretKey: Uint8Array): string =>
  getPublicKey(secretKey)

// NIP-44 "self-DM": the conversation key between the backup key and its own
// pubkey - decryptable by the seed holder and nobody else
const selfConversationKey = (secretKey: Uint8Array): Uint8Array =>
  nip44v2.utils.getConversationKey(secretKey, getPublicKey(secretKey))

// a relay could serve a multi-megabyte content string; JSON.parse and
// NIP-44 decrypt of that would hang the tab. A real backup is a handful of
// kilobytes per part - this is far beyond generous (applyBackup's own
// per-record bounds still apply on top after decrypt)
const MAX_BACKUP_CONTENT_CHARS = 16 * 1024 * 1024

export const dTagOf = (event: NostrEvent): string =>
  event.tags.find(t => t[0] === 'd')?.[1] ?? ''

const envelopeFor = (
  part: BackupPart,
  payload: BackupPartPayload[BackupPart]
): string => {
  switch (part) {
    case 'notes':
      return JSON.stringify({version: 1, bearers: payload})
    case 'mints':
      return JSON.stringify({version: 1, trustedMints: payload})
    case 'settings':
      return JSON.stringify({version: 1, settings: payload})
  }
}

// signs one addressable backup event for a single part
export const buildBackupEvent = <P extends BackupPart>(
  secretKey: Uint8Array,
  part: P,
  payload: BackupPartPayload[P],
  createdAt: number = Math.floor(Date.now() / 1000)
): NostrEvent =>
  finalizeEvent(
    {
      kind: BACKUP_EVENT_KIND,
      created_at: createdAt,
      tags: [['d', BACKUP_D_TAGS[part]]],
      content: nip44v2.encrypt(
        envelopeFor(part, payload),
        selfConversationKey(secretKey)
      )
    },
    secretKey
  )

// one event per part present in `parts`, all sharing one timestamp
export const buildBackupEvents = (
  secretKey: Uint8Array,
  parts: Partial<BackupPartPayload>,
  createdAt?: number
): NostrEvent[] => {
  const at = createdAt ?? Math.floor(Date.now() / 1000)
  const events: NostrEvent[] = []
  for (const part of BACKUP_PARTS) {
    const payload = parts[part]
    if (payload === undefined) continue
    events.push(buildBackupEvent(secretKey, part, payload, at))
  }
  return events
}

export type ParsedBackupEvent =
  | {part: 'notes'; bearers: EncryptedBearerRecord[]}
  | {part: 'mints'; trustedMints: TrustedMint[]}
  | {part: 'settings'; settings: WalletSettings}

// Light shape checks so parse returns typed values; the strict bounds
// (record counts, field lengths, pubkey patterns) are enforced by
// applyBackup / mergeTrustedMints on the restore path, same as file
// backups.
const parsePayload = (
  dTag: BackupPart,
  data: unknown
): ParsedBackupEvent | null => {
  if (typeof data !== 'object' || data === null) return null
  const envelope = data as Record<string, unknown>
  if (envelope.version !== 1) return null
  switch (dTag) {
    case 'notes': {
      if (!Array.isArray(envelope.bearers)) return null
      const bearers = envelope.bearers as unknown[]
      if (
        !bearers.every(
          r =>
            typeof (r as EncryptedBearerRecord)?.id === 'string' &&
            typeof (r as EncryptedBearerRecord)?.iv === 'string' &&
            typeof (r as EncryptedBearerRecord)?.ciphertext === 'string'
        )
      ) {
        return null
      }
      return {part: 'notes', bearers: bearers as EncryptedBearerRecord[]}
    }
    case 'mints': {
      if (!Array.isArray(envelope.trustedMints)) return null
      const mints = envelope.trustedMints as unknown[]
      if (
        !mints.every(
          m =>
            typeof (m as TrustedMint)?.server === 'string' &&
            typeof (m as TrustedMint)?.mintPubkey === 'string'
        )
      ) {
        return null
      }
      return {part: 'mints', trustedMints: mints as TrustedMint[]}
    }
    case 'settings': {
      if (typeof envelope.settings !== 'object' || envelope.settings === null) {
        return null
      }
      const settings = envelope.settings as Record<string, unknown>
      if (
        settings.defaultMint !== undefined &&
        typeof settings.defaultMint !== 'string'
      ) {
        return null
      }
      return {part: 'settings', settings: settings as WalletSettings}
    }
  }
}

// Validates and decrypts one backup event. Returns null for anything that
// isn't a genuine, untampered backup of THIS key: wrong kind, wrong d-tag,
// wrong author, bad signature, undecryptable or malformed payload. Callers
// skip nulls - one junk event must never sink a restore.
export const parseBackupEvent = (
  secretKey: Uint8Array,
  event: NostrEvent
): ParsedBackupEvent | null => {
  if (event.kind !== BACKUP_EVENT_KIND) return null
  if (event.pubkey !== getPublicKey(secretKey)) return null
  const dTag = dTagOf(event)
  if (dTag !== 'notes' && dTag !== 'mints' && dTag !== 'settings') return null
  if (!verifyEvent(event)) return null
  if (event.content.length > MAX_BACKUP_CONTENT_CHARS) return null
  let plaintext: string
  try {
    plaintext = nip44v2.decrypt(event.content, selfConversationKey(secretKey))
  } catch {
    return null
  }
  let data: unknown
  try {
    data = JSON.parse(plaintext)
  } catch {
    return null
  }
  return parsePayload(dTag, data)
}
