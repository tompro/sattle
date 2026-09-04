// The pure crypto core of passkey unlock (passkeys.ts): HKDF-SHA256 from a
// WebAuthn PRF output to an AES-GCM wrap key, and wrap/unwrap of canonical
// wallet material under it. No WebAuthn or storage is involved, so malformed
// decrypted material is rejected at this boundary before it can reach runtime.
//
// A per-slot random HKDF salt separates the wrap keys of different passkeys
// even though the ceremony-side PRF salt is fixed (see passkeys.ts); the
// info string domain-separates these keys from any other key ever derived
// from the same PRF output.

import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {sha256} from '@noble/hashes/sha2.js'

import type {PasskeyWrap} from './storage/passkeySlots'
import {parseWalletMaterial, serializeWalletMaterial} from './storage/storedSecret'
import type {WalletMaterialV2} from './storage/storedSecret'

const WRAP_KEY_HKDF_INFO = 'sattle-passkey-wrap-v2'

export class InvalidPasskeyMaterialError extends Error {
  override readonly name = 'InvalidPasskeyMaterialError'

  constructor() {
    super('Passkey payload is not canonical v2 wallet material.')
  }
}

export const derivePasskeyWrapKey = async (
  prfOutput: Uint8Array,
  hkdfSalt: Uint8Array,
): Promise<CryptoKey> => {
  const baseKey = await crypto.subtle.importKey('raw', new Uint8Array(prfOutput), 'HKDF', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    // the copies pin the TS type to Uint8Array<ArrayBuffer> - hexToBytes
    // returns Uint8Array<ArrayBufferLike>, which BufferSource rejects
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(hkdfSalt),
      info: new Uint8Array(utf8ToBytes(WRAP_KEY_HKDF_INFO)),
    },
    baseKey,
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt'],
  )
}

export const wrapWalletMaterialWithPrf = async (
  prfOutput: Uint8Array,
  material: WalletMaterialV2,
): Promise<PasskeyWrap> => {
  const hkdfSalt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrapKey = await derivePasskeyWrapKey(prfOutput, hkdfSalt)
  const serialized = serializeWalletMaterial(material)
  if (parseWalletMaterial(serialized) === null) throw new InvalidPasskeyMaterialError()
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({name: 'AES-GCM', iv}, wrapKey, utf8ToBytes(serialized)),
  )
  return {
    hkdfSalt: bytesToHex(hkdfSalt),
    iv: bytesToHex(iv),
    materialHash: bytesToHex(sha256(utf8ToBytes(serialized))),
    wrappedMaterial: bytesToHex(ciphertext),
  }
}

// rejects (WebCrypto's own auth-tag check) if the PRF output is wrong -
// i.e. a different passkey than the one that created the slot
export const unwrapWalletMaterialWithPrf = async (
  prfOutput: Uint8Array,
  wrap: PasskeyWrap,
): Promise<WalletMaterialV2> => {
  const wrapKey = await derivePasskeyWrapKey(prfOutput, hexToBytes(wrap.hkdfSalt))
  const plaintext = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv: new Uint8Array(hexToBytes(wrap.iv))},
    wrapKey,
    new Uint8Array(hexToBytes(wrap.wrappedMaterial)),
  )
  const serialized = new TextDecoder().decode(plaintext)
  if (bytesToHex(sha256(utf8ToBytes(serialized))) !== wrap.materialHash) {
    throw new InvalidPasskeyMaterialError()
  }
  const material = parseWalletMaterial(serialized)
  if (material === null) throw new InvalidPasskeyMaterialError()
  return material
}
