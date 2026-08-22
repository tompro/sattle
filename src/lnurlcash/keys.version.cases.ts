import {beforeEach, describe, expect, it} from 'vitest'
import {bytesToHex} from '@noble/hashes/utils.js'

import {
  ensureSavedKeyOwner,
  getPlainLinkingKey,
  isValidStoredSecret,
  linkingPubKeyHex,
  savedKeyExists,
  savedKeyOwnerId,
  saveLinkingKey,
} from './keys'
import {parseJsonObject, stubLocalStorage} from './test-utils'

const LINKING_KEY = new Uint8Array(32).fill(7)
const OTHER_LINKING_KEY = new Uint8Array(32).fill(9)
const STORAGE_KEY = 'sattle_linking_key'

const readRawRecord = (): Record<string, unknown> => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === null) throw new Error('expected a saved linking-key record')
  return parseJsonObject(raw)
}

beforeEach(() => {
  stubLocalStorage()
})

describe('saved-key schema version', () => {
  it('writes version 1 on current plaintext and encrypted records', async () => {
    // Given a linking key saved through each current persistence path
    await saveLinkingKey(LINKING_KEY)
    const plaintext = readRawRecord()
    await saveLinkingKey(LINKING_KEY, 'correct horse')
    const encrypted = readRawRecord()

    // When the persisted schema metadata is inspected
    // Then both owner-bearing records carry the recognized discriminator
    expect(plaintext.version).toBe(1)
    expect(encrypted.version).toBe(1)
  })

  it('upgrades an unversioned same-owner record only after key proof', () => {
    // Given the valid owner-bearing shape written before schema versioning
    const ownerId = linkingPubKeyHex(LINKING_KEY)
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({enc: false, value: bytesToHex(LINKING_KEY), ownerId}),
    )

    // When it is read before and then stamped after the plaintext key proves ownership
    expect(savedKeyOwnerId()).toBeNull()
    const provenKey = getPlainLinkingKey()
    if (provenKey === null) throw new Error('expected the compatible plaintext key')
    ensureSavedKeyOwner(provenKey)

    // Then it becomes an explicitly versioned current record
    expect(readRawRecord()).toEqual({
      enc: false,
      value: bytesToHex(LINKING_KEY),
      ownerId,
      version: 1,
    })
  })

  it.each([2, '1', null])('rejects unsupported or malformed version %j', (version) => {
    // Given an otherwise valid owner-bearing record with unrecognized metadata
    const record = {
      enc: false,
      value: bytesToHex(LINKING_KEY),
      ownerId: linkingPubKeyHex(LINKING_KEY),
      version,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record))

    // When the saved-key boundary parses it
    // Then the record is neither usable nor eligible for legacy adoption
    expect(isValidStoredSecret(record)).toBe(false)
    expect(savedKeyExists()).toBe(false)
    expect(savedKeyOwnerId()).toBeNull()
    expect(getPlainLinkingKey()).toBeNull()
  })

  it('rejects a foreign current owner at the proven-key stamping boundary', () => {
    // Given a versioned record whose owner conflicts with its plaintext key
    const record = {
      enc: false,
      value: bytesToHex(LINKING_KEY),
      ownerId: linkingPubKeyHex(OTHER_LINKING_KEY),
      version: 1,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record))
    const before = localStorage.getItem(STORAGE_KEY)

    // When the actual key is proven
    const stamp = () => ensureSavedKeyOwner(LINKING_KEY)

    // Then the foreign claim fails closed without rewriting storage
    expect(stamp).toThrow('different wallet')
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before)
  })
})
