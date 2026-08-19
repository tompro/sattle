// Trusted-mint registry: key pinning, rekey staging, and backup merge
// rules. Runs against an in-memory localStorage stub.

import {beforeEach, describe, expect, it} from 'vitest'

import type {TrustedMint} from './trustedMints'
import {
  PUBLIC_MINTS,
  addTrustedMint,
  clearTrustedMints,
  confirmTrustedMintRekey,
  dismissTrustedMintRekey,
  getTrustedMintPubkey,
  grandfatherTrustedMint,
  isMintTrusted,
  isMintUnconfirmed,
  lockTrustedMint,
  mergeTrustedMints,
  readTrustedMints,
  removeTrustedMint
} from './trustedMints'
import {stubLocalStorage} from './test-utils'

const KEY_A = '02' + 'aa'.repeat(32)
const KEY_B = '03' + 'bb'.repeat(32)
const KEY_C = '02' + 'cc'.repeat(32)
const SERVER = 'mint.example'

beforeEach(() => {
  stubLocalStorage()
  clearTrustedMints()
})

describe('pinning', () => {
  it('locks a mint the first time a bearer is held from it', () => {
    expect(lockTrustedMint(SERVER, KEY_A)).toBe('added')
    expect(isMintTrusted(SERVER)).toBe(true)
    expect(getTrustedMintPubkey(SERVER)).toBe(KEY_A)
    expect(readTrustedMints()[0]!.locked).toBe(true)
    // same key again: silent no-op
    expect(lockTrustedMint(SERVER, KEY_A)).toBe('unchanged')
  })

  it('rejects a malformed signing key without throwing', () => {
    expect(lockTrustedMint(SERVER, 'not-a-key')).toBe('unchanged')
    expect(isMintTrusted(SERVER)).toBe(false)
  })
})

describe('rekey staging', () => {
  it('stages a differing advertised key for review, never auto-applies it', () => {
    lockTrustedMint(SERVER, KEY_A)

    expect(lockTrustedMint(SERVER, KEY_B)).toBe('rekey-pending')
    const mint = readTrustedMints()[0]!
    // the staged candidate is visible, but the ORIGINAL pin is still
    // authoritative - this is the entire point of the staging model
    expect(mint.pendingMintPubkey).toBe(KEY_B)
    expect(mint.mintPubkey).toBe(KEY_A)
    expect(getTrustedMintPubkey(SERVER)).toBe(KEY_A)

    // re-advertising the same pending key doesn't duplicate or escalate
    expect(lockTrustedMint(SERVER, KEY_B)).toBe('rekey-pending')
    expect(readTrustedMints()[0]!.mintPubkey).toBe(KEY_A)

    // and a THIRD key replaces the staged candidate, still not the pin
    expect(lockTrustedMint(SERVER, KEY_C)).toBe('rekey-pending')
    expect(readTrustedMints()[0]!.pendingMintPubkey).toBe(KEY_C)
    expect(readTrustedMints()[0]!.mintPubkey).toBe(KEY_A)
  })

  it('promotes the staged key only on explicit holder confirmation', () => {
    lockTrustedMint(SERVER, KEY_A)
    lockTrustedMint(SERVER, KEY_B)

    confirmTrustedMintRekey(SERVER)
    const mint = readTrustedMints()[0]!
    expect(mint.mintPubkey).toBe(KEY_B)
    expect(mint.pendingMintPubkey).toBeUndefined()
    expect(getTrustedMintPubkey(SERVER)).toBe(KEY_B)
  })

  it('drops the staged key on dismissal, keeping the original pin', () => {
    lockTrustedMint(SERVER, KEY_A)
    lockTrustedMint(SERVER, KEY_B)

    dismissTrustedMintRekey(SERVER)
    const mint = readTrustedMints()[0]!
    expect(mint.pendingMintPubkey).toBeUndefined()
    expect(mint.mintPubkey).toBe(KEY_A)
  })

  it('stages a rekey even through unlock-time grandfathering', () => {
    grandfatherTrustedMint(SERVER, KEY_A)
    expect(grandfatherTrustedMint(SERVER, KEY_B)).toBe('rekey-pending')
    expect(readTrustedMints()[0]!.mintPubkey).toBe(KEY_A)
  })
})

describe('grandfathering (storage-sourced claims)', () => {
  it('adds an unknown server unlocked and unconfirmed', () => {
    expect(grandfatherTrustedMint(SERVER, KEY_A)).toBe('added')
    const mint = readTrustedMints()[0]!
    expect(mint.locked).toBe(false)
    expect(mint.unconfirmed).toBe(true)
    // unconfirmed pins stay out of offline signature verification
    expect(getTrustedMintPubkey(SERVER)).toBeNull()
    expect(isMintUnconfirmed(SERVER)).toBe(true)
  })

  it('is corroborated and locked by a live response advertising the same key', () => {
    grandfatherTrustedMint(SERVER, KEY_A)
    expect(lockTrustedMint(SERVER, KEY_A)).toBe('unchanged')
    const mint = readTrustedMints()[0]!
    expect(mint.locked).toBe(true)
    expect(mint.unconfirmed).toBeUndefined()
    expect(getTrustedMintPubkey(SERVER)).toBe(KEY_A)
  })
})

describe('manual add and removal', () => {
  it('validates input instead of silently no-oping', () => {
    expect(() => addTrustedMint('', KEY_A)).toThrow()
    expect(() => addTrustedMint(SERVER, 'junk')).toThrow()
  })

  it('refuses to remove a mint locked by a held bearer', () => {
    lockTrustedMint(SERVER, KEY_A)
    expect(() => removeTrustedMint(SERVER)).toThrow(/bearer/)
    expect(isMintTrusted(SERVER)).toBe(true)
  })

  it('removes an unlocked mint', () => {
    addTrustedMint(SERVER, KEY_A)
    removeTrustedMint(SERVER)
    expect(isMintTrusted(SERVER)).toBe(false)
  })
})

describe('backup merge', () => {
  const fromFile = (overrides: Record<string, unknown> = {}) => ({
    server: 'backup-mint.example',
    mintPubkey: KEY_B,
    addedAt: 123,
    locked: true, // must never survive a merge from a file
    pendingMintPubkey: KEY_C, // must never survive either
    nodeAlias: 'Backup Mint',
    ...overrides
  })

  it('merges unknown servers as unlocked, unconfirmed, and without staged keys', () => {
    expect(mergeTrustedMints([fromFile()])).toBe(1)
    const mint = readTrustedMints()[0]!
    expect(mint.server).toBe('backup-mint.example')
    expect(mint.mintPubkey).toBe(KEY_B)
    expect(mint.locked).toBe(false)
    expect(mint.unconfirmed).toBe(true)
    expect(mint.pendingMintPubkey).toBeUndefined()
    expect(mint.nodeAlias).toBe('Backup Mint')
  })

  it('never overwrites a server this device already knows', () => {
    lockTrustedMint(SERVER, KEY_A)
    const added = mergeTrustedMints([fromFile({server: SERVER, mintPubkey: KEY_B})])
    expect(added).toBe(0)
    expect(getTrustedMintPubkey(SERVER)).toBe(KEY_A)
  })

  it('skips malformed entries', () => {
    // JSON round-trip: a backup file's entries are runtime data, not
    // compile-time TrustedMints - the merge must filter, not trust
    const malformed: TrustedMint[] = JSON.parse(
      JSON.stringify([
        fromFile({mintPubkey: 'not-hex'}),
        fromFile({server: 42}),
        null
      ])
    )
    expect(mergeTrustedMints(malformed)).toBe(0)
    expect(readTrustedMints()).toEqual([])
  })
})

describe('PUBLIC_MINTS', () => {
  it('is the curated quick-start list, ported verbatim from lnurl-wallet', () => {
    expect(PUBLIC_MINTS).toEqual([
      '@mint.600.wtf',
      '@lnurl.21mint.me',
      '@mint.forgesworn.dev',
      '@lnurl.21linz.at',
      '@minty.exe.xyz'
    ])
  })
})
