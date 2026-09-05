import {beforeEach, describe, expect, it} from 'vitest'
import {bytesToHex} from '@noble/hashes/utils.js'

import {
  deriveWalletMaterial,
  ensureSavedWalletMaterialOwner,
  getPlainWalletMaterial,
  linkingPubKeyHex,
  savedWalletMaterialOwnerId,
  saveWalletMaterial,
  walletMaterialHash,
} from './keys'
import {migrateLegacyPasskeySlots, readPasskeySlots} from './passkeys'
import type {PasskeySlot} from './passkeys'
import {parseJsonObjectArray, stubLocalStorage} from './test-utils'

const LINKING_KEY = new Uint8Array(32).fill(7)
const OTHER_LINKING_KEY = new Uint8Array(32).fill(9)
const MATERIAL_STORAGE = 'sattle_wallet_material_v2'
const SLOT_STORAGE = 'sattle_passkey_slots'
const MATERIAL = {
  ...deriveWalletMaterial(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  ),
  linkingKeyHex: bytesToHex(LINKING_KEY),
}

const SLOT_BASE = {
  credentialId: '11'.repeat(16),
  hkdfSalt: '22'.repeat(16),
  iv: '33'.repeat(12),
  materialHash: walletMaterialHash(MATERIAL),
  wrappedMaterial: '55'.repeat(128),
  createdAt: 1,
} as const

const writeRawSlots = (slots: readonly Record<string, unknown>[]): void => {
  localStorage.setItem(SLOT_STORAGE, JSON.stringify(slots))
}

// strips the v2 record's owner marker back to the unproven post-restore form
const removeSavedOwnerMarker = (): void => {
  const stored: unknown = JSON.parse(localStorage.getItem(MATERIAL_STORAGE) ?? '{}')
  if (typeof stored !== 'object' || stored === null) throw new TypeError('expected a record')
  const stripped: Record<string, unknown> = {...stored}
  delete stripped.ownerId
  delete stripped.version
  localStorage.setItem(MATERIAL_STORAGE, JSON.stringify(stripped))
}

describe('passkey-slot schema version', () => {
  beforeEach(async () => {
    stubLocalStorage()
    await saveWalletMaterial(MATERIAL)
  })
  it('reads a current version 2 slot for the exact saved owner', () => {
    // Given a current saved-material owner marker and passkey record
    const ownerId = linkingPubKeyHex(LINKING_KEY)
    const slot: PasskeySlot = {...SLOT_BASE, ownerId, version: 2}
    writeRawSlots([slot])

    // When current-owner slots are read
    // Then the recognized version is exposed unchanged
    expect(readPasskeySlots()).toEqual([slot])
  })

  it('upgrades markerless and unversioned same-owner slots only after saved-material proof', async () => {
    // Given records written before schema versioning and a saved material
    // whose owner marker was never proven (the post-restore form)
    const ownerId = linkingPubKeyHex(LINKING_KEY)
    removeSavedOwnerMarker()
    writeRawSlots([SLOT_BASE, {...SLOT_BASE, credentialId: '55'.repeat(16), ownerId}])

    // When migration is attempted before and after the saved material proves ownership
    await expect(migrateLegacyPasskeySlots(LINKING_KEY)).rejects.toThrow('proven owner')
    const provenMaterial = getPlainWalletMaterial()
    if (provenMaterial === null) throw new Error('expected the compatible plaintext material')
    ensureSavedWalletMaterialOwner(provenMaterial)
    await migrateLegacyPasskeySlots(LINKING_KEY)

    // Then both compatible legacy forms become current records
    expect(savedWalletMaterialOwnerId()).toBe(ownerId)
    expect(parseJsonObjectArray(localStorage.getItem(SLOT_STORAGE) ?? '[]')).toEqual([
      {...SLOT_BASE, ownerId, version: 2},
      {...SLOT_BASE, credentialId: '55'.repeat(16), ownerId, version: 2},
    ])
  })

  it.each([1, 3, '2', null])('hides unsupported or malformed version %j', (version) => {
    // Given an otherwise valid slot carrying unrecognized metadata
    const ownerId = linkingPubKeyHex(LINKING_KEY)
    writeRawSlots([{...SLOT_BASE, ownerId, version}])

    // When slots are parsed
    // Then future or malformed records are unavailable and not downgraded to legacy
    expect(readPasskeySlots()).toEqual([])
  })

  it('hides a foreign version 1 slot from the current owner', () => {
    // Given the saved owner and slot owner differ
    writeRawSlots([{...SLOT_BASE, ownerId: linkingPubKeyHex(OTHER_LINKING_KEY), version: 2}])

    // When the current wallet reads passkeys
    // Then the foreign credential is unavailable
    expect(readPasskeySlots()).toEqual([])
  })
})
