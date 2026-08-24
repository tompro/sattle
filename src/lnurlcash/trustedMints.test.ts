// Trusted-mint registry: key pinning, rekey staging, and backup merge
// rules. Runs against an in-memory localStorage stub.

import {beforeEach, describe, expect, it} from 'vitest'

import {linkingPubKeyHex, saveLinkingKey} from './keys'
import type {TrustedMint} from './trustedMints'
import {
  PUBLIC_MINTS,
  addTrustedMint,
  confirmTrustedMintRekey,
  dismissTrustedMintRekey,
  getTrustedMintPubkey,
  grandfatherTrustedMint,
  isMintTrusted,
  isMintUnconfirmed,
  lockTrustedMint,
  mergeTrustedMints,
  readTrustedMints,
  removeTrustedMint,
} from './trustedMints'
import {stubLocalStorage} from './test-utils'

const KEY_A = '02' + 'aa'.repeat(32)
const KEY_B = '03' + 'bb'.repeat(32)
const KEY_C = '02' + 'cc'.repeat(32)
const SERVER = 'mint.example'
const LINKING_KEY = new Uint8Array(32).fill(7)
const OWNER_ID = linkingPubKeyHex(LINKING_KEY)

beforeEach(async () => {
  stubLocalStorage()
  await saveLinkingKey(LINKING_KEY)
})

const onlyMint = (): TrustedMint => {
  const mint = readTrustedMints(OWNER_ID)[0]
  if (!mint) throw new Error('Expected one trusted mint.')
  return mint
}

describe('pinning', () => {
  it('locks a mint the first time a bearer is held from it', async () => {
    expect(await lockTrustedMint(SERVER, KEY_A, OWNER_ID)).toBe('added')
    expect(isMintTrusted(SERVER, OWNER_ID)).toBe(true)
    expect(getTrustedMintPubkey(SERVER, OWNER_ID)).toBe(KEY_A)
    expect(onlyMint().locked).toBe(true)
    // same key again: silent no-op
    expect(await lockTrustedMint(SERVER, KEY_A, OWNER_ID)).toBe('unchanged')
  })

  it('rejects a malformed signing key without throwing', async () => {
    expect(await lockTrustedMint(SERVER, 'not-a-key', OWNER_ID)).toBe('unchanged')
    expect(isMintTrusted(SERVER, OWNER_ID)).toBe(false)
  })
})

describe('rekey staging', () => {
  it('stages a differing advertised key for review, never auto-applies it', async () => {
    await lockTrustedMint(SERVER, KEY_A, OWNER_ID)

    expect(await lockTrustedMint(SERVER, KEY_B, OWNER_ID)).toBe('rekey-pending')
    const mint = onlyMint()
    // the staged candidate is visible, but the ORIGINAL pin is still
    // authoritative - this is the entire point of the staging model
    expect(mint.pendingMintPubkey).toBe(KEY_B)
    expect(mint.mintPubkey).toBe(KEY_A)
    expect(getTrustedMintPubkey(SERVER, OWNER_ID)).toBe(KEY_A)

    // re-advertising the same pending key doesn't duplicate or escalate
    expect(await lockTrustedMint(SERVER, KEY_B, OWNER_ID)).toBe('rekey-pending')
    expect(onlyMint().mintPubkey).toBe(KEY_A)

    // and a THIRD key replaces the staged candidate, still not the pin
    expect(await lockTrustedMint(SERVER, KEY_C, OWNER_ID)).toBe('rekey-pending')
    expect(onlyMint().pendingMintPubkey).toBe(KEY_C)
    expect(onlyMint().mintPubkey).toBe(KEY_A)
  })

  it('promotes the staged key only on explicit holder confirmation', async () => {
    await lockTrustedMint(SERVER, KEY_A, OWNER_ID)
    await lockTrustedMint(SERVER, KEY_B, OWNER_ID)

    await confirmTrustedMintRekey(SERVER, OWNER_ID)
    const mint = onlyMint()
    expect(mint.mintPubkey).toBe(KEY_B)
    expect(mint.pendingMintPubkey).toBeUndefined()
    expect(getTrustedMintPubkey(SERVER, OWNER_ID)).toBe(KEY_B)
  })

  it('drops the staged key on dismissal, keeping the original pin', async () => {
    await lockTrustedMint(SERVER, KEY_A, OWNER_ID)
    await lockTrustedMint(SERVER, KEY_B, OWNER_ID)

    await dismissTrustedMintRekey(SERVER, OWNER_ID)
    const mint = onlyMint()
    expect(mint.pendingMintPubkey).toBeUndefined()
    expect(mint.mintPubkey).toBe(KEY_A)
  })

  it('stages a rekey even through unlock-time grandfathering', async () => {
    await grandfatherTrustedMint(SERVER, KEY_A, OWNER_ID)
    expect(await grandfatherTrustedMint(SERVER, KEY_B, OWNER_ID)).toBe('rekey-pending')
    expect(onlyMint().mintPubkey).toBe(KEY_A)
  })
})

describe('grandfathering (storage-sourced claims)', () => {
  it('adds an unknown server unlocked and unconfirmed', async () => {
    expect(await grandfatherTrustedMint(SERVER, KEY_A, OWNER_ID)).toBe('added')
    const mint = onlyMint()
    expect(mint.locked).toBe(false)
    expect(mint.unconfirmed).toBe(true)
    // unconfirmed pins stay out of offline signature verification
    expect(getTrustedMintPubkey(SERVER, OWNER_ID)).toBeNull()
    expect(isMintUnconfirmed(SERVER, OWNER_ID)).toBe(true)
  })

  it('is corroborated and locked by a live response advertising the same key', async () => {
    await grandfatherTrustedMint(SERVER, KEY_A, OWNER_ID)
    expect(await lockTrustedMint(SERVER, KEY_A, OWNER_ID)).toBe('unchanged')
    const mint = onlyMint()
    expect(mint.locked).toBe(true)
    expect(mint.unconfirmed).toBeUndefined()
    expect(getTrustedMintPubkey(SERVER, OWNER_ID)).toBe(KEY_A)
  })
})

describe('manual add and removal', () => {
  it('validates input instead of silently no-oping', async () => {
    await expect(addTrustedMint('', KEY_A, {ownerId: OWNER_ID})).rejects.toThrow()
    await expect(addTrustedMint(SERVER, 'junk', {ownerId: OWNER_ID})).rejects.toThrow()
  })

  it('refuses to remove a mint locked by a held bearer', async () => {
    await lockTrustedMint(SERVER, KEY_A, OWNER_ID)
    await expect(removeTrustedMint(SERVER, OWNER_ID)).rejects.toThrow(/bearer/)
    expect(isMintTrusted(SERVER, OWNER_ID)).toBe(true)
  })

  it('removes an unlocked mint', async () => {
    await addTrustedMint(SERVER, KEY_A, {ownerId: OWNER_ID})
    await removeTrustedMint(SERVER, OWNER_ID)
    expect(isMintTrusted(SERVER, OWNER_ID)).toBe(false)
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
    ...overrides,
  })

  it('merges unknown servers as unlocked, unconfirmed, and without staged keys', async () => {
    expect(await mergeTrustedMints([fromFile()], OWNER_ID)).toBe(1)
    const mint = onlyMint()
    expect(mint.server).toBe('backup-mint.example')
    expect(mint.mintPubkey).toBe(KEY_B)
    expect(mint.locked).toBe(false)
    expect(mint.unconfirmed).toBe(true)
    expect(mint.pendingMintPubkey).toBeUndefined()
    expect(mint.nodeAlias).toBe('Backup Mint')
  })

  it('never overwrites a server this device already knows', async () => {
    await lockTrustedMint(SERVER, KEY_A, OWNER_ID)
    const added = await mergeTrustedMints([fromFile({server: SERVER, mintPubkey: KEY_B})], OWNER_ID)
    expect(added).toBe(0)
    expect(getTrustedMintPubkey(SERVER, OWNER_ID)).toBe(KEY_A)
  })

  it('skips malformed entries', async () => {
    // JSON round-trip: a backup file's entries are runtime data, not
    // compile-time TrustedMints - the merge must filter, not trust
    const malformed: TrustedMint[] = JSON.parse(
      JSON.stringify([fromFile({mintPubkey: 'not-hex'}), fromFile({server: 42}), null]),
    )
    expect(await mergeTrustedMints(malformed, OWNER_ID)).toBe(0)
    expect(readTrustedMints(OWNER_ID)).toEqual([])
  })
})

describe('security policy characterization', () => {
  it('keeps local pins authoritative and requires explicit rekey confirmation', async () => {
    await lockTrustedMint(SERVER, KEY_A, OWNER_ID)

    expect(
      await mergeTrustedMints(
        [
          {
            server: SERVER,
            mintPubkey: KEY_C,
            addedAt: 123,
            locked: false,
          },
        ],
        OWNER_ID,
      ),
    ).toBe(0)
    expect(await lockTrustedMint(SERVER, KEY_B, OWNER_ID)).toBe('rekey-pending')
    expect(getTrustedMintPubkey(SERVER, OWNER_ID)).toBe(KEY_A)

    await confirmTrustedMintRekey(SERVER, OWNER_ID)

    expect(getTrustedMintPubkey(SERVER, OWNER_ID)).toBe(KEY_B)
    await expect(removeTrustedMint(SERVER, OWNER_ID)).rejects.toThrow(/bearer/)
  })
})

describe('PUBLIC_MINTS', () => {
  it('is the curated quick-start list, ported verbatim from lnurl-wallet', () => {
    expect(PUBLIC_MINTS).toEqual([
      '@mint.600.wtf',
      '@lnurl.21mint.me',
      '@mint.forgesworn.dev',
      '@lnurl.21linz.at',
      '@minty.exe.xyz',
    ])
  })
})
