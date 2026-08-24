// Saved linking-key record tests. The baseline describes pin the observable
// behavior of saveLinkingKey/decryptSavedLinkingKey/getPlainLinkingKey/
// restoreLinkingKeyStored as it existed before the owner marker (they must
// keep passing unchanged); the owner-marker describes cover the ownerId
// field that binds the saved key to its one proven wallet identity.
// Node env: in-memory localStorage stub, native WebCrypto.

import {beforeEach, describe, expect, it} from 'vitest'
import {bytesToHex} from '@noble/hashes/utils.js'

import {
  decryptSavedLinkingKey,
  encryptSecretParts,
  ensureSavedKeyOwner,
  getPlainLinkingKey,
  linkingPubKeyHex,
  restoreLinkingKeyStored,
  savedKeyExists,
  savedKeyIsEncrypted,
  savedKeyOwnerMatches,
  savedKeyOwnerId,
  saveLinkingKey,
} from './keys'
import {isWalletOwnerId} from './storage/walletOwner'
import {parseJsonObject, stubLocalStorage} from './test-utils'

import './keys.version.cases'

const LINKING_KEY = new Uint8Array(32).fill(7)
const OTHER_KEY = new Uint8Array(32).fill(9)
const PASSWORD = 'hunter2'

const STORAGE_KEY = 'sattle_linking_key'

const readRawRecord = (): Record<string, unknown> => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === null) throw new Error('expected a saved linking-key record')
  return parseJsonObject(raw)
}

beforeEach(() => {
  stubLocalStorage()
})

// hand-written records in the pre-owner-marker shape - what every wallet
// created before this change has on disk
const saveLegacyPlaintext = (key: Uint8Array): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({enc: false, value: bytesToHex(key)}))
}

const saveLegacyEncrypted = async (
  key: Uint8Array,
  password: string,
): Promise<Record<string, unknown>> => {
  const parts = await encryptSecretParts(bytesToHex(key), password)
  const record: Record<string, unknown> = {enc: true, ...parts}
  localStorage.setItem(STORAGE_KEY, JSON.stringify(record))
  return record
}

describe('baseline: saved-key record behavior', () => {
  it('saves a plaintext key and reads it back', async () => {
    await saveLinkingKey(LINKING_KEY)

    expect(savedKeyExists()).toBe(true)
    expect(savedKeyIsEncrypted()).toBe(false)
    expect(readRawRecord()).toMatchObject({enc: false, value: bytesToHex(LINKING_KEY)})
    expect(getPlainLinkingKey()).toEqual(LINKING_KEY)
  })

  it('saves a password-encrypted key and decrypts it with the password', async () => {
    await saveLinkingKey(LINKING_KEY, PASSWORD)

    expect(savedKeyIsEncrypted()).toBe(true)
    const record = readRawRecord()
    expect(record.enc).toBe(true)
    expect(record.value).toBeUndefined()
    // an encrypted record never reads through the plaintext path
    expect(getPlainLinkingKey()).toBeNull()
    expect(await decryptSavedLinkingKey(PASSWORD)).toEqual(LINKING_KEY)
  })

  it('rejects the wrong password via the GCM auth tag', async () => {
    await saveLinkingKey(LINKING_KEY, PASSWORD)
    await expect(decryptSavedLinkingKey('wrong password')).rejects.toThrow()
  })

  it('throws when asked to decrypt a plaintext record', async () => {
    await saveLinkingKey(LINKING_KEY)
    await expect(decryptSavedLinkingKey(PASSWORD)).rejects.toThrow(
      'No encrypted linking key saved.',
    )
  })

  it('restores an ownerless record verbatim and reads it back', async () => {
    const parts = await encryptSecretParts(bytesToHex(LINKING_KEY), PASSWORD)
    const record = {enc: true as const, ...parts}
    restoreLinkingKeyStored(record)

    expect(readRawRecord()).toEqual(record)
    expect(savedKeyIsEncrypted()).toBe(true)
    expect(await decryptSavedLinkingKey(PASSWORD)).toEqual(LINKING_KEY)
  })

  it('drops a malformed stored record instead of trusting it', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({enc: true, salt: 'zz', iv: '00', ciphertext: ''}),
    )
    expect(savedKeyExists()).toBe(false)
    localStorage.setItem(STORAGE_KEY, 'not json')
    expect(savedKeyExists()).toBe(false)
    expect(getPlainLinkingKey()).toBeNull()
  })
})

describe('owner marker on new writes', () => {
  it('matches the canonical owner derived from the saved linking key', async () => {
    // Given a newly saved owner-bearing key
    await saveLinkingKey(LINKING_KEY)

    // When its freshly derived linking key is compared
    const matches = savedKeyOwnerMatches(LINKING_KEY)

    // Then the saved owner matches
    expect(matches).toBe(true)
  })

  it('does not match a different linking key', async () => {
    // Given a key owned by this wallet
    await saveLinkingKey(LINKING_KEY)

    // When a foreign freshly derived linking key is compared
    const matches = savedKeyOwnerMatches(OTHER_KEY)

    // Then the foreign key is rejected
    expect(matches).toBe(false)
  })

  it('stamps the same canonical owner on plaintext and encrypted saves', async () => {
    await saveLinkingKey(LINKING_KEY)
    const plainOwner = savedKeyOwnerId()
    expect(plainOwner).toBe(linkingPubKeyHex(LINKING_KEY))

    await saveLinkingKey(LINKING_KEY, PASSWORD)
    expect(savedKeyOwnerId()).toBe(plainOwner)
    expect(savedKeyOwnerId()).toBe(linkingPubKeyHex(LINKING_KEY))
  })

  it('derives the owner as the lowercase 66-char compressed pubkey hex', async () => {
    await saveLinkingKey(LINKING_KEY)
    expect(savedKeyOwnerId()).toMatch(/^0[23][0-9a-f]{64}$/)
  })
})

describe('owner marker on legacy records', () => {
  it('reads a legacy record without ownerId as ownerless', async () => {
    saveLegacyPlaintext(LINKING_KEY)
    expect(savedKeyOwnerId()).toBeNull()
    // the record itself stays a fully valid saved key
    expect(getPlainLinkingKey()).toEqual(LINKING_KEY)

    await saveLegacyEncrypted(LINKING_KEY, PASSWORD)
    expect(savedKeyOwnerId()).toBeNull()
    expect(await decryptSavedLinkingKey(PASSWORD)).toEqual(LINKING_KEY)
  })

  it('rejects malformed owner-bearing records instead of treating them as legacy', () => {
    const real = linkingPubKeyHex(LINKING_KEY)
    const junk: unknown[] = [
      real.slice(1), // wrong length (65)
      real + '00', // wrong length (68)
      real.toUpperCase(), // uppercase hex
      'zz' + real.slice(2), // non-hex
      '04' + real.slice(2), // not a compressed-pubkey prefix
      '02' + 'ff'.repeat(32), // hex of the right length, not a curve point
      42, // wrong type
      null,
      {pubkey: real},
      '',
    ]
    for (const ownerId of junk) {
      saveLegacyPlaintext(LINKING_KEY)
      localStorage.setItem(STORAGE_KEY, JSON.stringify({...readRawRecord(), ownerId}))
      // the junk marker never reads as an owner...
      expect(savedKeyOwnerId()).toBeNull()
      // ...or downgrades to an adoptable ownerless legacy record
      expect(savedKeyExists()).toBe(false)
      expect(getPlainLinkingKey()).toBeNull()
    }
  })

  it('stamps the owner after a password unlock without touching the ciphertext', async () => {
    // Given a legacy encrypted record with no owner marker
    const before = await saveLegacyEncrypted(LINKING_KEY, PASSWORD)

    // When ownership is proven by a successful unlock and then stamped
    const linkingKey = await decryptSavedLinkingKey(PASSWORD)
    ensureSavedKeyOwner(linkingKey)

    // Then the marker names the proven key and every ciphertext byte is
    // preserved
    const after = readRawRecord()
    expect(after.ownerId).toBe(linkingPubKeyHex(LINKING_KEY))
    expect(after.ciphertext).toBe(before.ciphertext)
    expect(after.salt).toBe(before.salt)
    expect(after.iv).toBe(before.iv)
  })

  it('stamps a plaintext legacy record after a plaintext unlock', () => {
    saveLegacyPlaintext(LINKING_KEY)
    const linkingKey = getPlainLinkingKey()
    if (linkingKey === null) throw new Error('expected a plaintext key')
    ensureSavedKeyOwner(linkingKey)

    expect(readRawRecord()).toEqual({
      enc: false,
      value: bytesToHex(LINKING_KEY),
      version: 1,
      ownerId: linkingPubKeyHex(LINKING_KEY),
    })
  })

  it('is idempotent - stamping twice leaves storage untouched after the first write', async () => {
    const before = await saveLegacyEncrypted(LINKING_KEY, PASSWORD)
    const linkingKey = await decryptSavedLinkingKey(PASSWORD)

    ensureSavedKeyOwner(linkingKey)
    const afterFirst = localStorage.getItem(STORAGE_KEY)
    ensureSavedKeyOwner(linkingKey)

    expect(localStorage.getItem(STORAGE_KEY)).toBe(afterFirst)
    expect(readRawRecord().ciphertext).toBe(before.ciphertext)
  })

  it('writes nothing when a new-format record is already correctly stamped', async () => {
    await saveLinkingKey(LINKING_KEY, PASSWORD)
    const raw = localStorage.getItem(STORAGE_KEY)
    ensureSavedKeyOwner(LINKING_KEY)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw)
  })

  it('refuses to restamp a record owned by a different wallet', async () => {
    await saveLinkingKey(OTHER_KEY, PASSWORD)
    const before = localStorage.getItem(STORAGE_KEY)

    expect(() => ensureSavedKeyOwner(LINKING_KEY)).toThrow()
    // the failed stamp leaves the record - marker included - untouched
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before)
    expect(savedKeyOwnerId()).toBe(linkingPubKeyHex(OTHER_KEY))
  })

  it('refuses to stamp a key that contradicts a plaintext record', () => {
    saveLegacyPlaintext(OTHER_KEY)
    expect(() => ensureSavedKeyOwner(LINKING_KEY)).toThrow()
    expect(savedKeyOwnerId()).toBeNull()
  })

  it('does not adopt a record carrying a junk owner marker', () => {
    saveLegacyPlaintext(LINKING_KEY)
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({...readRawRecord(), ownerId: 'obviously junk'}),
    )
    ensureSavedKeyOwner(LINKING_KEY)
    expect(savedKeyOwnerId()).toBeNull()
    expect(savedKeyExists()).toBe(false)
  })

  it('is a no-op when no record is saved at all', () => {
    ensureSavedKeyOwner(LINKING_KEY)
    expect(savedKeyExists()).toBe(false)
  })
})

describe('owner marker on restore', () => {
  it('strips the unproven ownerId a restored record arrives with', async () => {
    // a backup file can claim any marker - only a freshly derived key may
    // establish ownership, so restore installs the secret parts alone
    restoreLinkingKeyStored({
      enc: false,
      value: bytesToHex(LINKING_KEY),
      ownerId: linkingPubKeyHex(OTHER_KEY),
    })
    expect(savedKeyOwnerId()).toBeNull()
    expect(getPlainLinkingKey()).toEqual(LINKING_KEY)

    // the first proven unlock then establishes the true owner
    ensureSavedKeyOwner(LINKING_KEY)
    expect(savedKeyOwnerId()).toBe(linkingPubKeyHex(LINKING_KEY))
  })

  it('strips a junk ownerId from a restored encrypted record', async () => {
    const parts = await encryptSecretParts(bytesToHex(LINKING_KEY), PASSWORD)
    restoreLinkingKeyStored({enc: true, ...parts, ownerId: 42})
    expect(savedKeyOwnerId()).toBeNull()
    expect(await decryptSavedLinkingKey(PASSWORD)).toEqual(LINKING_KEY)
  })
})

describe('isWalletOwnerId', () => {
  it('accepts exactly what linkingPubKeyHex produces', () => {
    expect(isWalletOwnerId(linkingPubKeyHex(LINKING_KEY))).toBe(true)
    expect(isWalletOwnerId(linkingPubKeyHex(OTHER_KEY))).toBe(true)
  })

  it('rejects everything else', () => {
    const real = linkingPubKeyHex(LINKING_KEY)
    expect(isWalletOwnerId(real.toUpperCase())).toBe(false)
    expect(isWalletOwnerId(real.slice(0, 64))).toBe(false)
    expect(isWalletOwnerId('02' + 'ff'.repeat(32))).toBe(false)
    expect(isWalletOwnerId(66)).toBe(false)
    expect(isWalletOwnerId(undefined)).toBe(false)
    expect(isWalletOwnerId(null)).toBe(false)
  })
})
