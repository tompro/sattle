import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils.js'
import {beforeEach, describe, expect, it} from 'vitest'

import {
  decryptSavedWalletMaterial,
  deriveWalletMaterial,
  encryptSecretParts,
  ensureSavedWalletMaterialOwner,
  getPlainWalletMaterial,
  isValidStoredWalletMaterial,
  linkingPubKeyHex,
  restoreWalletMaterialStored,
  saveWalletMaterial,
  serializeWalletMaterial,
  savedWalletMaterialOwnerId,
  walletMaterialLinkingKey,
  WalletMaterialProofMismatchError,
} from './keys'
import {walletMaterialOwnerId} from './storage/storedSecret'
import {parseJsonObject, stubLocalStorage} from './test-utils'

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const OTHER_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow'
const MATERIAL_STORAGE_KEY = 'sattle_wallet_material_v2'
const PASSWORD = 'correct horse battery staple'

const materialHash = (serialized: string): string =>
  bytesToHex(sha256(utf8ToBytes(serialized)))

const readRawMaterialRecord = (): Record<string, unknown> => {
  const raw = localStorage.getItem(MATERIAL_STORAGE_KEY)
  if (raw === null) throw new Error('expected a saved wallet-material record')
  return parseJsonObject(raw)
}

beforeEach(() => {
  stubLocalStorage()
})

describe('baseline: wallet material identity', () => {
  it('derives identity only from the linking key when the cash root changes', () => {
    const material = deriveWalletMaterial(MNEMONIC)
    const other = deriveWalletMaterial(OTHER_MNEMONIC)
    const alteredRoot = {...material, cashRootHex: other.cashRootHex}

    expect(walletMaterialOwnerId(alteredRoot)).toBe(walletMaterialOwnerId(material))
    expect(serializeWalletMaterial(alteredRoot)).not.toBe(serializeWalletMaterial(material))
  })
})

describe('saved wallet material commitment', () => {
  it('stores the canonical material commitment on plaintext and encrypted saves', async () => {
    const material = deriveWalletMaterial(MNEMONIC)
    const expectedHash = materialHash(serializeWalletMaterial(material))

    await saveWalletMaterial(material)
    const plaintext = readRawMaterialRecord()
    await saveWalletMaterial(material, PASSWORD)
    const encrypted = readRawMaterialRecord()

    expect(plaintext.materialHash).toBe(expectedHash)
    expect(encrypted.materialHash).toBe(expectedHash)
  })

  it('rejects authenticated encrypted material when its commitment differs', async () => {
    const material = deriveWalletMaterial(MNEMONIC)
    await saveWalletMaterial(material, PASSWORD)
    localStorage.setItem(
      MATERIAL_STORAGE_KEY,
      JSON.stringify({...readRawMaterialRecord(), materialHash: '00'.repeat(32)}),
    )

    await expect(decryptSavedWalletMaterial(PASSWORD)).rejects.toBeInstanceOf(
      WalletMaterialProofMismatchError,
    )
  })

  it('rejects plaintext material when its commitment differs', async () => {
    const material = deriveWalletMaterial(MNEMONIC)
    await saveWalletMaterial(material)
    const before = JSON.stringify({...readRawMaterialRecord(), materialHash: '00'.repeat(32)})
    localStorage.setItem(MATERIAL_STORAGE_KEY, before)

    expect(getPlainWalletMaterial()).toBeNull()
    expect(localStorage.getItem(MATERIAL_STORAGE_KEY)).toBe(before)
  })

  it('refuses to stamp same-owner material with an altered cash root', async () => {
    const material = deriveWalletMaterial(MNEMONIC)
    const other = deriveWalletMaterial(OTHER_MNEMONIC)
    await saveWalletMaterial(material, PASSWORD)

    expect(() =>
      ensureSavedWalletMaterialOwner({...material, cashRootHex: other.cashRootHex}),
    ).toThrow(WalletMaterialProofMismatchError)
  })

  it('requires exactly one lowercase 64-hex commitment at the storage boundary', () => {
    const material = deriveWalletMaterial(MNEMONIC)
    const serialized = serializeWalletMaterial(material)
    const record = {
      enc: false,
      value: serialized,
      materialHash: materialHash(serialized),
      ownerId: walletMaterialOwnerId(material),
      version: 2,
    }

    expect(isValidStoredWalletMaterial(record)).toBe(true)
    expect(isValidStoredWalletMaterial({...record, materialHash: record.materialHash.toUpperCase()})).toBe(
      false,
    )
    expect(
      isValidStoredWalletMaterial({
        enc: record.enc,
        value: record.value,
        ownerId: record.ownerId,
        version: record.version,
      }),
    ).toBe(false)
  })

  it('rejects malformed authenticated material after its correct commitment matches', async () => {
    const material = deriveWalletMaterial(MNEMONIC)
    const malformed = JSON.stringify({...material, cashRootHex: '00'.repeat(64)})
    const parts = await encryptSecretParts(malformed, PASSWORD)
    localStorage.setItem(
      MATERIAL_STORAGE_KEY,
      JSON.stringify({
        enc: true,
        ...parts,
        materialHash: materialHash(malformed),
        ownerId: linkingPubKeyHex(walletMaterialLinkingKey(material)),
        version: 2,
      }),
    )

    await expect(decryptSavedWalletMaterial(PASSWORD)).rejects.toThrow(
      'valid v2 wallet material',
    )
  })

  it('preserves a verified restored commitment while discarding its owner claim', () => {
    const material = deriveWalletMaterial(MNEMONIC)
    const serialized = serializeWalletMaterial(material)

    restoreWalletMaterialStored({
      enc: false,
      value: serialized,
      materialHash: materialHash(serialized),
      ownerId: linkingPubKeyHex(new Uint8Array(32).fill(9)),
      version: 2,
    })

    expect(readRawMaterialRecord()).toEqual({
      enc: false,
      value: serialized,
      materialHash: materialHash(serialized),
    })
    expect(getPlainWalletMaterial()).toEqual(material)
  })

  it('proves an encrypted restored commitment before owner stamping', async () => {
    const material = deriveWalletMaterial(MNEMONIC)
    const serialized = serializeWalletMaterial(material)
    const parts = await encryptSecretParts(serialized, PASSWORD)
    restoreWalletMaterialStored({
      enc: true,
      ...parts,
      materialHash: materialHash(serialized),
      ownerId: linkingPubKeyHex(new Uint8Array(32).fill(9)),
      version: 2,
    })

    expect(savedWalletMaterialOwnerId()).toBeNull()
    const proven = await decryptSavedWalletMaterial(PASSWORD)
    ensureSavedWalletMaterialOwner(proven)

    expect(savedWalletMaterialOwnerId()).toBe(walletMaterialOwnerId(material))
  })

  it('rejects an unproven restored hash that contradicts encrypted material', async () => {
    const material = deriveWalletMaterial(MNEMONIC)
    const serialized = serializeWalletMaterial(material)
    const parts = await encryptSecretParts(serialized, PASSWORD)
    restoreWalletMaterialStored({
      enc: true,
      ...parts,
      materialHash: '00'.repeat(32),
      ownerId: walletMaterialOwnerId(material),
      version: 2,
    })

    await expect(decryptSavedWalletMaterial(PASSWORD)).rejects.toBeInstanceOf(
      WalletMaterialProofMismatchError,
    )
    expect(savedWalletMaterialOwnerId()).toBeNull()
  })
})
