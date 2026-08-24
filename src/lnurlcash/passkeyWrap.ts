// The pure crypto core of passkey unlock (passkeys.ts): HKDF-SHA256 from a
// WebAuthn PRF output to an AES-GCM wrap key, and wrap/unwrap of the
// linking key under it. No WebAuthn, no storage - a PRF output is just 32
// bytes, so everything here is unit-testable in plain Node.
//
// A per-slot random HKDF salt separates the wrap keys of different passkeys
// even though the ceremony-side PRF salt is fixed (see passkeys.ts); the
// info string domain-separates these keys from any other key ever derived
// from the same PRF output.

import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'

import type {PasskeyWrap} from './storage/passkeySlots'

const WRAP_KEY_HKDF_INFO = 'sattle-passkey-wrap-v1'

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

export const wrapLinkingKeyWithPrf = async (
  prfOutput: Uint8Array,
  linkingKey: Uint8Array,
): Promise<PasskeyWrap> => {
  const hkdfSalt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const wrapKey = await derivePasskeyWrapKey(prfOutput, hkdfSalt)
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({name: 'AES-GCM', iv}, wrapKey, new Uint8Array(linkingKey)),
  )
  return {
    hkdfSalt: bytesToHex(hkdfSalt),
    iv: bytesToHex(iv),
    wrappedKey: bytesToHex(ciphertext),
  }
}

// rejects (WebCrypto's own auth-tag check) if the PRF output is wrong -
// i.e. a different passkey than the one that created the slot
export const unwrapLinkingKeyWithPrf = async (
  prfOutput: Uint8Array,
  wrap: PasskeyWrap,
): Promise<Uint8Array> => {
  const wrapKey = await derivePasskeyWrapKey(prfOutput, hexToBytes(wrap.hkdfSalt))
  const plaintext = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv: new Uint8Array(hexToBytes(wrap.iv))},
    wrapKey,
    new Uint8Array(hexToBytes(wrap.wrappedKey)),
  )
  return new Uint8Array(plaintext)
}
