// V2 passkey cases exercise the material boundary without exposing private
// material in assertions or diagnostics. The fake authenticator models only
// WebAuthn credential selection and deterministic PRF evaluation.

import {hmac} from '@noble/hashes/hmac.js'
import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils.js'
import {beforeEach, describe, expect, it} from 'vitest'

import {
  deriveWalletMaterial,
  saveWalletMaterial,
  serializeWalletMaterial,
} from './keys'
import {
  derivePasskeyWrapKey,
  getPasskeyPrfOutput,
  readPasskeySlots,
  registerPasskey,
  rewrapAllSlots,
  unlockWalletMaterialWithPasskey,
  unwrapWalletMaterialWithPrf,
  wrapWalletMaterialWithPrf,
} from './passkeys'
import type {CeremonyCredential, PasskeyCredentials, PasskeyWrap} from './passkeys'
import {stubLocalStorage} from './test-utils'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const OTHER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const MATERIAL = {...deriveWalletMaterial(MNEMONIC), linkingKeyHex: '07'.repeat(32)}
const OTHER_MATERIAL = deriveWalletMaterial(OTHER_MNEMONIC)
const PRF_OUTPUT = new Uint8Array(32).fill(3)
const OTHER_PRF_OUTPUT = new Uint8Array(32).fill(4)
const SLOT_STORAGE_KEY = 'sattle_passkey_slots'

const toBytes = (source: BufferSource): Uint8Array =>
  source instanceof ArrayBuffer
    ? new Uint8Array(source)
    : new Uint8Array(source.buffer, source.byteOffset, source.byteLength)

class FakeAuthenticator implements PasskeyCredentials {
  private readonly credentialId = new Uint8Array(16).fill(5)
  private secret = new Uint8Array(32).fill(6)
  onGet?: () => Promise<void>
  cancelCreate = false

  rotateSecret = (): void => {
    this.secret = new Uint8Array(32).fill(7)
  }

  create = async (options?: CredentialCreationOptions): Promise<CeremonyCredential | null> => {
    if (this.cancelCreate) return null
    return this.credential(options?.publicKey?.extensions?.prf?.eval?.first)
  }

  get = async (options?: CredentialRequestOptions): Promise<CeremonyCredential | null> => {
    await this.onGet?.()
    const allowed = options?.publicKey?.allowCredentials ?? []
    const selected = allowed.some(
      (descriptor) => bytesToHex(toBytes(descriptor.id)) === bytesToHex(this.credentialId),
    )
    return selected
      ? this.credential(options?.publicKey?.extensions?.prf?.eval?.first)
      : null
  }

  private credential = (salt: BufferSource | undefined): CeremonyCredential => ({
    type: 'public-key',
    rawId: this.credentialId,
    getClientExtensionResults: () => ({
      prf: salt
        ? {enabled: true, results: {first: new Uint8Array(hmac(sha256, this.secret, toBytes(salt)))}}
        : {},
    }),
  })
}

const rawSlots = (): string => localStorage.getItem(SLOT_STORAGE_KEY) ?? ''
const alterLastByte = (hex: string): string =>
  `${hex.slice(0, -2)}${hex.endsWith('00') ? '01' : '00'}`

const encryptPayload = async (
  prfOutput: Uint8Array,
  payload: string,
  materialHash: string,
): Promise<PasskeyWrap> => {
  const hkdfSalt = new Uint8Array(16).fill(8)
  const iv = new Uint8Array(12).fill(9)
  const wrapKey = await derivePasskeyWrapKey(prfOutput, hkdfSalt)
  const ciphertext = await crypto.subtle.encrypt(
    {name: 'AES-GCM', iv},
    wrapKey,
    utf8ToBytes(payload),
  )
  return {
    hkdfSalt: bytesToHex(hkdfSalt),
    iv: bytesToHex(iv),
    materialHash,
    wrappedMaterial: bytesToHex(new Uint8Array(ciphertext)),
  }
}

beforeEach(async () => {
  stubLocalStorage()
  await saveWalletMaterial(MATERIAL)
})

describe('v2 passkey material', () => {
  it('round-trips canonical material bytes through the PRF wrap', async () => {
    const wrap = await wrapWalletMaterialWithPrf(PRF_OUTPUT, MATERIAL)

    await expect(unwrapWalletMaterialWithPrf(PRF_OUTPUT, wrap)).resolves.toEqual(MATERIAL)
  })

  it('rejects wrong PRF and altered ciphertext without changing the wrap', async () => {
    const wrap = await wrapWalletMaterialWithPrf(PRF_OUTPUT, MATERIAL)
    const before = JSON.stringify(wrap)
    const altered = {
      ...wrap,
      wrappedMaterial: alterLastByte(wrap.wrappedMaterial),
    }

    await expect(unwrapWalletMaterialWithPrf(OTHER_PRF_OUTPUT, wrap)).rejects.toThrow()
    await expect(unwrapWalletMaterialWithPrf(PRF_OUTPUT, altered)).rejects.toThrow()
    expect(JSON.stringify(wrap)).toBe(before)
  })

  it.each([
    ['legacy key-only payload', MATERIAL.linkingKeyHex],
    [
      'malformed root',
      JSON.stringify({...MATERIAL, cashRootHex: `${MATERIAL.cashRootHex.slice(0, -2)}00`}),
    ],
  ])('rejects authenticated %s without changing slots or activation', async (_name, payload) => {
    const authenticator = new FakeAuthenticator()
    const slot = await registerPasskey(MATERIAL, {credentials: authenticator})
    const prfOutput = await getPasskeyPrfOutput(slot.credentialId, {credentials: authenticator})
    const materialHash = bytesToHex(sha256(utf8ToBytes(serializeWalletMaterial(MATERIAL))))
    const wrap = await encryptPayload(prfOutput, payload, materialHash)
    localStorage.setItem(SLOT_STORAGE_KEY, JSON.stringify([{...slot, ...wrap}]))
    const before = rawSlots()
    let activated = false

    await expect(
      unlockWalletMaterialWithPasskey({credentials: authenticator}).then(() => {
        activated = true
      }),
    ).rejects.toThrow()
    expect(activated).toBe(false)
    expect(rawSlots()).toBe(before)
  })

  it('rejects a wrong runtime PRF without changing slots or activation', async () => {
    const authenticator = new FakeAuthenticator()
    await registerPasskey(MATERIAL, {credentials: authenticator})
    const before = rawSlots()
    let activated = false
    authenticator.rotateSecret()

    await expect(
      unlockWalletMaterialWithPasskey({credentials: authenticator}).then(() => {
        activated = true
      }),
    ).rejects.toThrow()
    expect(activated).toBe(false)
    expect(rawSlots()).toBe(before)
  })

  it('rejects altered stored ciphertext without rewriting it or activating', async () => {
    const authenticator = new FakeAuthenticator()
    const slot = await registerPasskey(MATERIAL, {credentials: authenticator})
    const altered = {
      ...slot,
      wrappedMaterial: alterLastByte(slot.wrappedMaterial),
    }
    localStorage.setItem(SLOT_STORAGE_KEY, JSON.stringify([altered]))
    const before = rawSlots()
    let activated = false

    await expect(
      unlockWalletMaterialWithPasskey({credentials: authenticator}).then(() => {
        activated = true
      }),
    ).rejects.toThrow()
    expect(activated).toBe(false)
    expect(rawSlots()).toBe(before)
  })

  it('rejects same-owner altered root at registration without a ceremony or slot write', async () => {
    const authenticator = new FakeAuthenticator()
    const alteredRoot = {...MATERIAL, cashRootHex: OTHER_MATERIAL.cashRootHex}

    await expect(registerPasskey(alteredRoot, {credentials: authenticator})).rejects.toThrow(
      'saved wallet material',
    )
    expect(rawSlots()).toBe('')
  })

  it('registers and unlocks complete material without plaintext slot leakage', async () => {
    const authenticator = new FakeAuthenticator()
    const slot = await registerPasskey(MATERIAL, {credentials: authenticator})

    const unlocked = await unlockWalletMaterialWithPasskey({credentials: authenticator})

    expect(unlocked).toEqual(MATERIAL)
    expect(slot.ownerId).not.toContain(MATERIAL.linkingKeyHex)
    expect(rawSlots()).not.toContain(MATERIAL.linkingKeyHex)
    expect(rawSlots()).not.toContain(MATERIAL.cashRootHex)
  })

  it('rejects authenticated foreign-owner material without changing slots or activation', async () => {
    const authenticator = new FakeAuthenticator()
    const slot = await registerPasskey(MATERIAL, {credentials: authenticator})
    const prfOutput = await getPasskeyPrfOutput(slot.credentialId, {credentials: authenticator})
    const foreignWrap = await wrapWalletMaterialWithPrf(prfOutput, OTHER_MATERIAL)
    localStorage.setItem(SLOT_STORAGE_KEY, JSON.stringify([{...slot, ...foreignWrap}]))
    const before = rawSlots()
    let activated = false

    await expect(
      unlockWalletMaterialWithPasskey({credentials: authenticator}).then(() => {
        activated = true
      }),
    ).rejects.toThrow('different wallet')
    expect(activated).toBe(false)
    expect(rawSlots()).toBe(before)
  })

  it('rejects a slot changed during its ceremony without changing storage or activation', async () => {
    const authenticator = new FakeAuthenticator()
    await registerPasskey(MATERIAL, {credentials: authenticator})
    let changed = ''
    authenticator.onGet = async () => {
      const slot = readPasskeySlots()[0]
      if (slot === undefined) throw new Error('expected registered slot')
      localStorage.setItem(SLOT_STORAGE_KEY, JSON.stringify([{...slot, createdAt: slot.createdAt + 1}]))
      changed = rawSlots()
    }
    let activated = false

    await expect(
      unlockWalletMaterialWithPasskey({credentials: authenticator}).then(() => {
        activated = true
      }),
    ).rejects.toThrow('changed')
    expect(activated).toBe(false)
    expect(rawSlots()).toBe(changed)
  })

  it('rewraps every slot around byte-identical material or writes nothing', async () => {
    const authenticator = new FakeAuthenticator()
    const slot = await registerPasskey(MATERIAL, {credentials: authenticator})
    const before = rawSlots()

    await expect(rewrapAllSlots(MATERIAL, new Map())).rejects.toThrow('partial re-wrap')
    expect(rawSlots()).toBe(before)

    const prfOutput = await getPasskeyPrfOutput(slot.credentialId, {credentials: authenticator})
    await rewrapAllSlots(MATERIAL, new Map([[slot.credentialId, prfOutput]]))
    await expect(unlockWalletMaterialWithPasskey({credentials: authenticator})).resolves.toEqual(
      MATERIAL,
    )
  })

  it('does not create a slot when registration is cancelled', async () => {
    const authenticator = new FakeAuthenticator()
    authenticator.cancelCreate = true

    await expect(registerPasskey(MATERIAL, {credentials: authenticator})).rejects.toThrow('cancelled')
    expect(rawSlots()).toBe('')
  })
})
