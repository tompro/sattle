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

describe('createBackupPublisher', () => {
  it('coalesces rapid schedules into a single publish of the latest snapshot', async () => {
    vi.useFakeTimers()
    const published: Partial<BackupPartPayload>[] = []
    const publisher = createBackupPublisher({
      publish: (p) => {
        published.push(p)
        return Promise.resolve()
      },
      delayMs: 1000,
    })

    publisher.schedule({settings: {defaultMint: 'a'}})
    publisher.schedule({settings: {defaultMint: 'b'}})
    publisher.schedule({settings: {defaultMint: 'c'}})
    await vi.advanceTimersByTimeAsync(999)
    expect(published).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(published).toEqual([{settings: {defaultMint: 'c'}}])
  })

  it('publishes again when a change lands after the quiet window', async () => {
    vi.useFakeTimers()
    const published: Partial<BackupPartPayload>[] = []
    const publisher = createBackupPublisher({
      publish: (p) => {
        published.push(p)
        return Promise.resolve()
      },
      delayMs: 1000,
    })

    publisher.schedule({settings: {defaultMint: 'a'}})
    await vi.advanceTimersByTimeAsync(1000)
    publisher.schedule({settings: {defaultMint: 'b'}})
    await vi.advanceTimersByTimeAsync(1000)
    expect(published).toEqual([{settings: {defaultMint: 'a'}}, {settings: {defaultMint: 'b'}}])
  })

  it('publishes a snapshot that lands mid-publish instead of losing it', async () => {
    vi.useFakeTimers()
    const published: Partial<BackupPartPayload>[] = []
    // the publish callback re-schedules on the publisher being created -
    // a holder indirection keeps both const
    const holder: {publisher?: ReturnType<typeof createBackupPublisher>} = {}
    const publisher = createBackupPublisher({
      publish: (p) => {
        published.push(p)
        // a local change lands while the first publish is in flight
        if (published.length === 1) {
          holder.publisher?.schedule({settings: {defaultMint: 'mid-flight'}})
        }
        return Promise.resolve()
      },
      delayMs: 1000,
    })
    holder.publisher = publisher

    publisher.schedule({settings: {defaultMint: 'first'}})
    await vi.advanceTimersByTimeAsync(1000)
    expect(published).toEqual([
      {settings: {defaultMint: 'first'}},
      {settings: {defaultMint: 'mid-flight'}},
    ])
  })

  it('flush publishes immediately; cancel drops the pending snapshot', async () => {
    vi.useFakeTimers()
    const published: Partial<BackupPartPayload>[] = []
    const publisher = createBackupPublisher({
      publish: (p) => {
        published.push(p)
        return Promise.resolve()
      },
      delayMs: 60_000,
    })

    publisher.schedule({settings: {defaultMint: 'a'}})
    await publisher.flush()
    expect(published).toEqual([{settings: {defaultMint: 'a'}}])

    publisher.schedule({settings: {defaultMint: 'b'}})
    publisher.cancel()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(published).toHaveLength(1)
  })

  it('reports a failed publish via onError and retries on the next change', async () => {
    vi.useFakeTimers()
    const published: Partial<BackupPartPayload>[] = []
    const errors: unknown[] = []
    let failing = true
    const publisher = createBackupPublisher({
      publish: (p) => {
        if (failing) return Promise.reject(new Error('relay down'))
        published.push(p)
        return Promise.resolve()
      },
      delayMs: 1000,
      onError: (e) => {
        errors.push(e)
      },
    })

    publisher.schedule({settings: {defaultMint: 'a'}})
    await vi.advanceTimersByTimeAsync(1000)
    expect(published).toEqual([])
    expect(errors).toHaveLength(1)

    failing = false
    publisher.schedule({settings: {defaultMint: 'b'}})
    await vi.advanceTimersByTimeAsync(1000)
    expect(published).toEqual([{settings: {defaultMint: 'b'}}])
  })
})
