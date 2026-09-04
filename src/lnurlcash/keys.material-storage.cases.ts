import {describe, expect, it} from 'vitest'

import {
  decryptSavedWalletMaterial,
  deriveWalletMaterial,
  encryptSecretParts,
  ensureSavedWalletMaterialOwner,
  getPlainWalletMaterial,
  isValidStoredWalletMaterial,
  linkingPubKeyHex,
  restoreWalletMaterialStored,
  savedWalletMaterialExists,
  savedWalletMaterialIsEncrypted,
  savedWalletMaterialOwnerId,
  saveWalletMaterial,
  serializeWalletMaterial,
  walletMaterialLinkingKey,
} from './keys'
import {parseJsonObject, stubLocalStorage} from './test-utils'

const FIXED_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const PASSWORD = 'correct horse battery staple'
const MATERIAL_STORAGE_KEY = 'sattle_wallet_material_v2'
const LEGACY_STORAGE_KEY = 'sattle_linking_key'
const LINKING_KEY_HEX = 'da2a752d3d28668288ff50bed644e4a95f726d8711fd8754060f0a9e378f84aa'
const CASH_ROOT_HEX =
  'c7a2496e9b453a67c5d2a1f04936ec1259440d45454c795a99a66269e4cd3005111e1cc966fca2fe32f054f14caceab90449e536d94cf6935ea12a087e414f60'

const readRawMaterialRecord = (): Record<string, unknown> => {
  const raw = localStorage.getItem(MATERIAL_STORAGE_KEY)
  if (raw === null) throw new Error('expected a saved wallet-material record')
  return parseJsonObject(raw)
}

describe('WalletMaterialV2 persistence', () => {
  it('round-trips canonical plaintext material in the new namespace', async () => {
    // Given complete wallet material and an unrelated legacy record
    stubLocalStorage()
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify({enc: false, value: '07'.repeat(32)}))
    const material = deriveWalletMaterial(FIXED_MNEMONIC)

    // When the material is saved without a password
    await saveWalletMaterial(material)

    // Then only the new namespace carries the exact complete material
    expect(savedWalletMaterialExists()).toBe(true)
    expect(savedWalletMaterialIsEncrypted()).toBe(false)
    expect(getPlainWalletMaterial()).toEqual(material)
    expect(readRawMaterialRecord()).toEqual({
      enc: false,
      value: serializeWalletMaterial(material),
      ownerId: linkingPubKeyHex(walletMaterialLinkingKey(material)),
      version: 2,
    })
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull()
    expect(localStorage.getItem(MATERIAL_STORAGE_KEY)).not.toContain(FIXED_MNEMONIC)
    expect(localStorage.getItem(MATERIAL_STORAGE_KEY)).not.toContain('"seed"')
  })

  it('round-trips canonical password-encrypted material without plaintext fields', async () => {
    // Given complete wallet material
    stubLocalStorage()
    const material = deriveWalletMaterial(FIXED_MNEMONIC)

    // When the material is password protected
    await saveWalletMaterial(material, PASSWORD)

    // Then only authenticated decryption returns both parts
    expect(savedWalletMaterialIsEncrypted()).toBe(true)
    expect(getPlainWalletMaterial()).toBeNull()
    expect(await decryptSavedWalletMaterial(PASSWORD)).toEqual(material)
    await expect(decryptSavedWalletMaterial('wrong password')).rejects.toThrow()
    const raw = JSON.stringify(readRawMaterialRecord())
    expect(raw).not.toContain(LINKING_KEY_HEX)
    expect(raw).not.toContain(CASH_ROOT_HEX)
    expect(raw).not.toContain(FIXED_MNEMONIC)
  })

  it('strips restored owner claims until the material proves its real owner', () => {
    // Given plaintext material carrying a foreign owner claim
    stubLocalStorage()
    const material = deriveWalletMaterial(FIXED_MNEMONIC)
    const foreignOwner = linkingPubKeyHex(new Uint8Array(32).fill(9))

    // When the record is restored and subsequently proven by plaintext unlock
    restoreWalletMaterialStored({
      enc: false,
      value: serializeWalletMaterial(material),
      ownerId: foreignOwner,
      version: 2,
    })
    const beforeProof = readRawMaterialRecord()
    const unlocked = getPlainWalletMaterial()
    if (unlocked === null) throw new Error('expected restored plaintext material')
    ensureSavedWalletMaterialOwner(unlocked)

    // Then the claim was absent before proof and only the derived owner was stamped
    expect(beforeProof).toEqual({enc: false, value: serializeWalletMaterial(material)})
    expect(savedWalletMaterialOwnerId()).toBe(linkingPubKeyHex(walletMaterialLinkingKey(material)))
  })

  it('rejects a plaintext owner mismatch without returning or stamping material', () => {
    // Given canonical material stamped with a foreign current owner
    stubLocalStorage()
    const material = deriveWalletMaterial(FIXED_MNEMONIC)
    localStorage.setItem(
      MATERIAL_STORAGE_KEY,
      JSON.stringify({
        enc: false,
        value: serializeWalletMaterial(material),
        ownerId: linkingPubKeyHex(new Uint8Array(32).fill(9)),
        version: 2,
      }),
    )
    const before = localStorage.getItem(MATERIAL_STORAGE_KEY)

    // When it is read or offered for proof
    const unlocked = getPlainWalletMaterial()
    const stamp = () => ensureSavedWalletMaterialOwner(material)

    // Then neither operation trusts or rewrites the foreign record
    expect(unlocked).toBeNull()
    expect(stamp).toThrow('different wallet')
    expect(localStorage.getItem(MATERIAL_STORAGE_KEY)).toBe(before)
  })

  it('rejects an encrypted owner mismatch after authentication', async () => {
    // Given valid encrypted material whose owner marker was replaced
    stubLocalStorage()
    const material = deriveWalletMaterial(FIXED_MNEMONIC)
    await saveWalletMaterial(material, PASSWORD)
    const foreign = {
      ...readRawMaterialRecord(),
      ownerId: linkingPubKeyHex(new Uint8Array(32).fill(9)),
    }
    localStorage.setItem(MATERIAL_STORAGE_KEY, JSON.stringify(foreign))
    const before = localStorage.getItem(MATERIAL_STORAGE_KEY)

    // When the authenticated material contradicts the current owner marker
    const unlock = decryptSavedWalletMaterial(PASSWORD)

    // Then no material is returned or marker changed
    await expect(unlock).rejects.toThrow('different wallet')
    expect(localStorage.getItem(MATERIAL_STORAGE_KEY)).toBe(before)
  })

  it.each([
    ['legacy key-only plaintext', LINKING_KEY_HEX, 2],
    ['wrong outer version', serializeWalletMaterial(deriveWalletMaterial(FIXED_MNEMONIC)), 1],
    [
      'malformed material plaintext',
      JSON.stringify({version: 2, linkingKeyHex: LINKING_KEY_HEX, cashRootHex: '00'}),
      2,
    ],
  ])('rejects %s records at the storage boundary', (_name, value, version) => {
    // Given an invalid record under the v2 material namespace
    stubLocalStorage()
    const material = deriveWalletMaterial(FIXED_MNEMONIC)
    const record = {
      enc: false,
      value,
      ownerId: linkingPubKeyHex(walletMaterialLinkingKey(material)),
      version,
    }
    localStorage.setItem(MATERIAL_STORAGE_KEY, JSON.stringify(record))

    // When storage helpers parse it
    // Then the record is unusable as wallet material
    expect(isValidStoredWalletMaterial(record)).toBe(false)
    expect(savedWalletMaterialExists()).toBe(false)
    expect(getPlainWalletMaterial()).toBeNull()
  })

  it('rejects authenticated ciphertext containing malformed material', async () => {
    // Given valid AES-GCM parts whose plaintext is not a v2 material envelope
    stubLocalStorage()
    const parts = await encryptSecretParts(LINKING_KEY_HEX, PASSWORD)
    const material = deriveWalletMaterial(FIXED_MNEMONIC)
    localStorage.setItem(
      MATERIAL_STORAGE_KEY,
      JSON.stringify({
        enc: true,
        ...parts,
        ownerId: linkingPubKeyHex(walletMaterialLinkingKey(material)),
        version: 2,
      }),
    )

    // When the password successfully authenticates the malformed plaintext
    const unlock = decryptSavedWalletMaterial(PASSWORD)

    // Then it still fails closed as invalid material
    await expect(unlock).rejects.toThrow('valid v2 wallet material')
  })
})
