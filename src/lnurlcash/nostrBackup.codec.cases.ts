// Nostr backup: key derivation stability, event build/parse round-trips,
// tamper rejection, publish/fetch and restore against an in-memory relay
// (the transport is injected - no network), and the debounced publisher.

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {bytesToHex} from '@noble/hashes/utils.js'
import type {NostrEvent} from 'nostr-tools/core'
import {finalizeEvent, getPublicKey} from 'nostr-tools/pure'
import {v2 as nip44v2} from 'nostr-tools/nip44'
import {buildNoteUrl} from 'lnurlcash-kit'

import {deriveBearerAesKey, linkingPubKeyHex, saveLinkingKey} from './keys'
import {
  BACKUP_EVENT_KIND,
  backupPubkey,
  buildBackupEvent,
  buildBackupEvents,
  createBackupPublisher,
  deriveBackupKey,
  fetchBackup,
  parseBackupEvent,
  publishBackup,
  restoreFromNostr,
} from './nostrBackup'
import type {BackupPartPayload, BackupTransport} from './nostrBackup'
import {
  loadBearers,
  loadSettings,
  mergeBearers,
  persistBearer,
  persistSettings,
  readEncryptedBearers,
} from './storage'
import type {Bearer} from './types'
import {addTrustedMint, isMintUnconfirmed, readTrustedMints} from './trustedMints'
import {requiredValue, stubLocalStorage} from './test-utils'

const LINKING_KEY = new Uint8Array(32).fill(7)
const OTHER_KEY = new Uint8Array(32).fill(9)
const OWNER_ID = linkingPubKeyHex(LINKING_KEY)

const K1_A = 'aa'.repeat(32)
const K1_B = 'bb'.repeat(32)
const MINT_PUBKEY = 'ab'.repeat(33)

// never connected - the recording transport below stands in for the relays
const RELAYS = ['wss://relay-a.example', 'wss://relay-b.example']

const bearerFixture = (overrides: Partial<Bearer> = {}): Bearer => ({
  id: 'fixture',
  url: buildNoteUrl('https://mint.example/w', K1_A, 21_000),
  callback: 'https://mint.example/w/cb',
  amount: 21_000,
  verified: true,
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
})

// an in-memory relay set. It serves EVERY event it ever accepted, older
// addressable copies included - like a relay that never replaces - which
// is exactly the case fetchBackup's client-side latest-pick exists for
const createRecordingTransport = (): {
  transport: BackupTransport
  events: NostrEvent[]
} => {
  const events: NostrEvent[] = []
  const transport: BackupTransport = {
    publish: (_relays, event) => {
      events.push(event)
      return Promise.resolve()
    },
    fetch: (_relays, filter) =>
      Promise.resolve(
        events.filter(
          (e) =>
            (!filter.kinds || filter.kinds.includes(e.kind)) &&
            (!filter.authors || filter.authors.includes(e.pubkey)),
        ),
      ),
  }
  return {transport, events}
}

// flips the end of a base64 payload to different-but-valid characters
const tamperContent = (content: string): string =>
  content.slice(0, -4) + (content.endsWith('AAAA') ? 'BBBB' : 'AAAA')

beforeEach(() => {
  stubLocalStorage()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('buildBackupEvent / parseBackupEvent', () => {
  const secretKey = deriveBackupKey(LINKING_KEY)

  const records = [
    // long unique sentinel id: a short id like 'r1' randomly appears in
    // base64 ciphertext (~17% for 700 chars), which flakes the no-plaintext
    // assertion below
    {id: 'record-id-plaintext-sentinel-7f3a', iv: '00'.repeat(12), ciphertext: 'ab'.repeat(40)},
  ]
  const mints = [{server: 'mint.example', mintPubkey: MINT_PUBKEY, addedAt: 1000, locked: true}]
  const settings = {defaultMint: 'mint.example'}

  it('round-trips all three parts through build and parse', () => {
    const events = buildBackupEvents(secretKey, {notes: records, mints, settings}, 1000)
    expect(events).toHaveLength(3)
    expect(events.map((e) => e.kind)).toEqual([
      BACKUP_EVENT_KIND,
      BACKUP_EVENT_KIND,
      BACKUP_EVENT_KIND,
    ])
    expect(events.map((e) => e.tags)).toEqual([
      [['d', 'notes']],
      [['d', 'mints']],
      [['d', 'settings']],
    ])
    expect(events.every((e) => e.pubkey === backupPubkey(secretKey))).toBe(true)

    expect(parseBackupEvent(secretKey, requiredValue(events[0]))).toEqual({
      part: 'notes',
      bearers: records,
    })
    expect(parseBackupEvent(secretKey, requiredValue(events[1]))).toEqual({
      part: 'mints',
      trustedMints: mints,
    })
    expect(parseBackupEvent(secretKey, requiredValue(events[2]))).toEqual({
      part: 'settings',
      settings,
    })
  })

  it('leaves no plaintext in the payload', () => {
    const event = buildBackupEvent(secretKey, 'notes', records)
    expect(event.content).not.toContain('record-id-plaintext-sentinel-7f3a')
    expect(event.content).not.toContain('ciphertext')
  })

  it('builds events only for the parts present', () => {
    const events = buildBackupEvents(secretKey, {settings}, 1000)
    expect(events).toHaveLength(1)
    expect(requiredValue(events[0]).tags).toEqual([['d', 'settings']])
  })

  it('rejects a payload encrypted for a different key', () => {
    const event = buildBackupEvent(secretKey, 'settings', settings)
    expect(parseBackupEvent(deriveBackupKey(OTHER_KEY), event)).toBeNull()
  })

  it('rejects the wrong kind', () => {
    const event = buildBackupEvent(secretKey, 'settings', settings)
    expect(parseBackupEvent(secretKey, {...event, kind: 30079})).toBeNull()
  })

  it('rejects an unknown d-tag', () => {
    const event = buildBackupEvent(secretKey, 'settings', settings)
    expect(parseBackupEvent(secretKey, {...event, tags: [['d', 'secrets']]})).toBeNull()
  })

  it('rejects a modified ciphertext - the signature no longer matches', () => {
    const event = buildBackupEvent(secretKey, 'settings', settings)
    const tampered = {...event, content: tamperContent(event.content)}
    expect(parseBackupEvent(secretKey, tampered)).toBeNull()
  })

  it('rejects an event signed by a different key', () => {
    const foreign = buildBackupEvent(deriveBackupKey(OTHER_KEY), 'settings', settings)
    expect(parseBackupEvent(secretKey, foreign)).toBeNull()
  })

  it('rejects a validly signed event whose payload is not a backup envelope', () => {
    // a same-key event of the right kind and d-tag, but its decrypted
    // content is not a version-1 envelope
    const conversationKey = nip44v2.utils.getConversationKey(secretKey, getPublicKey(secretKey))
    const event = finalizeEvent(
      {
        kind: BACKUP_EVENT_KIND,
        created_at: 1000,
        tags: [['d', 'settings']],
        content: nip44v2.encrypt(JSON.stringify({version: 2, settings: {}}), conversationKey),
      },
      secretKey,
    )
    expect(parseBackupEvent(secretKey, event)).toBeNull()
  })
})
