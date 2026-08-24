// Cross-tab events are hints, never authority: the current localStorage
// value is the only state a listener may project into a tab.

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {linkingPubKeyHex} from './keys'
import {onTrustedMintsChange, readTrustedMints, type TrustedMint} from './trustedMints'
import {stubLocalStorage} from './test-utils'

const STORAGE_KEY = 'sattle_trusted_mints'
const OWNER_ID = linkingPubKeyHex(new Uint8Array(32).fill(7))
const MINT_KEY = '02' + 'aa'.repeat(32)

const mint = (server: string): TrustedMint => ({
  server,
  mintPubkey: MINT_KEY,
  addedAt: 1,
  locked: false,
})

const store = (mints: TrustedMint[]): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({version: 1, ownerId: OWNER_ID, mints}))
}

const storageEvent = (key: string | null, newValue: string | null): Event => {
  const event = new Event('storage')
  Object.defineProperties(event, {
    key: {value: key},
    newValue: {value: newValue},
  })
  return event
}

beforeEach(() => {
  vi.unstubAllGlobals()
  stubLocalStorage()
})

describe('trusted-mint storage-event convergence', () => {
  it('projects a replacement from current storage instead of event newValue', () => {
    // Given a tab observing an existing trusted mint
    const events = new EventTarget()
    vi.stubGlobal('window', events)
    store([mint('before.example')])
    const observed: string[][] = []
    const unsubscribe = onTrustedMintsChange(() => {
      observed.push(readTrustedMints(OWNER_ID).map((entry) => entry.server))
    })

    try {
      // When another tab replaces storage but a delayed event carries obsolete bytes
      store([mint('current.example')])
      events.dispatchEvent(
        storageEvent(STORAGE_KEY, JSON.stringify({mints: [mint('before.example')]})),
      )

      // Then the projection follows the live registry
      expect(observed).toEqual([['current.example']])
    } finally {
      unsubscribe()
    }
  })

  it('projects removal from current storage instead of a stale replacement event', () => {
    // Given a tab observing a trusted mint
    const events = new EventTarget()
    vi.stubGlobal('window', events)
    store([mint('removed.example')])
    const observed: TrustedMint[][] = []
    const unsubscribe = onTrustedMintsChange(() => {
      observed.push(readTrustedMints(OWNER_ID))
    })

    try {
      // When the registry is removed while the event claims it still exists
      localStorage.removeItem(STORAGE_KEY)
      events.dispatchEvent(
        storageEvent(STORAGE_KEY, JSON.stringify({mints: [mint('removed.example')]})),
      )

      // Then the live removal wins
      expect(observed).toEqual([[]])
    } finally {
      unsubscribe()
    }
  })

  it('projects a clear event by rereading current localStorage', () => {
    // Given a tab observing a trusted mint
    const events = new EventTarget()
    vi.stubGlobal('window', events)
    store([mint('cleared.example')])
    const observed: TrustedMint[][] = []
    const unsubscribe = onTrustedMintsChange(() => {
      observed.push(readTrustedMints(OWNER_ID))
    })

    try {
      // When another tab clears storage, which emits key null
      localStorage.clear()
      events.dispatchEvent(storageEvent(null, JSON.stringify({mints: [mint('cleared.example')]})))

      // Then the live empty registry wins
      expect(observed).toEqual([[]])
    } finally {
      unsubscribe()
    }
  })

  it('ignores a delayed event after a newer live registry has replaced it', () => {
    // Given an observer and an obsolete first registry
    const events = new EventTarget()
    vi.stubGlobal('window', events)
    store([mint('obsolete.example')])
    const observed: string[][] = []
    const unsubscribe = onTrustedMintsChange(() => {
      observed.push(readTrustedMints(OWNER_ID).map((entry) => entry.server))
    })

    try {
      // When a newer registry is already live before the obsolete event arrives
      store([mint('live.example')])
      events.dispatchEvent(
        storageEvent(STORAGE_KEY, JSON.stringify({mints: [mint('obsolete.example')]})),
      )

      // Then the obsolete event cannot resurrect its value
      expect(observed).toEqual([['live.example']])
    } finally {
      unsubscribe()
    }
  })

  it('clears the projection for malformed current storage without throwing', () => {
    // Given an observer with a previously valid registry
    const events = new EventTarget()
    vi.stubGlobal('window', events)
    store([mint('valid.example')])
    const observed: TrustedMint[][] = []
    const unsubscribe = onTrustedMintsChange(() => {
      observed.push(readTrustedMints(OWNER_ID))
    })

    try {
      // When the current value is malformed and its event claims a valid old value
      localStorage.setItem(STORAGE_KEY, '{')
      events.dispatchEvent(
        storageEvent(STORAGE_KEY, JSON.stringify({mints: [mint('valid.example')]})),
      )

      // Then parsing the live value safely removes it from the projection
      expect(observed).toEqual([[]])
    } finally {
      unsubscribe()
    }
  })
})
