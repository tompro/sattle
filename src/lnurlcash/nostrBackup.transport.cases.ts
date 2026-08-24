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

describe('publishBackup / fetchBackup', () => {
  const secretKey = deriveBackupKey(LINKING_KEY)

  it('publishes every part and fetches them back decrypted', async () => {
    const {transport} = createRecordingTransport()
    const parts = {
      notes: [{id: 'r1', iv: '00'.repeat(12), ciphertext: 'ab'.repeat(40)}],
      mints: [{server: 'mint.example', mintPubkey: MINT_PUBKEY, addedAt: 1000, locked: false}],
      settings: {defaultMint: 'mint.example'},
    }
    const published = await publishBackup(secretKey, parts, RELAYS, {transport})
    expect(published.published).toEqual(['notes', 'mints', 'settings'])

    const fetched = await fetchBackup(backupPubkey(secretKey), RELAYS, {
      secretKey,
      transport,
    })
    expect(fetched).toEqual(parts)
  })

  it('publishes nothing when no parts are given', async () => {
    const {transport, events} = createRecordingTransport()
    const result = await publishBackup(secretKey, {}, RELAYS, {transport})
    expect(result.published).toEqual([])
    expect(events).toEqual([])
  })

  it('picks the newest event per d-tag when a relay serves stale copies', async () => {
    const {transport} = createRecordingTransport()
    await publishBackup(secretKey, {settings: {defaultMint: 'old.example'}}, RELAYS, {
      transport,
      createdAt: 1000,
    })
    await publishBackup(secretKey, {settings: {defaultMint: 'new.example'}}, RELAYS, {
      transport,
      createdAt: 2000,
    })
    // the recording transport serves BOTH - the newer must win
    const parts = await fetchBackup(backupPubkey(secretKey), RELAYS, {
      secretKey,
      transport,
    })
    expect(parts.settings).toEqual({defaultMint: 'new.example'})
  })

  it('falls back to an older valid copy when the newest event is tampered', async () => {
    const {transport, events} = createRecordingTransport()
    await publishBackup(secretKey, {settings: {defaultMint: 'mint.example'}}, RELAYS, {
      transport,
      createdAt: 1000,
    })
    const latest = requiredValue(events[0])
    events.push({
      ...latest,
      content: tamperContent(latest.content),
      created_at: 3000,
    })
    const parts = await fetchBackup(backupPubkey(secretKey), RELAYS, {
      secretKey,
      transport,
    })
    expect(parts.settings).toEqual({defaultMint: 'mint.example'})
  })
})
