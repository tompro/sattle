// Password wraps protect serialized wallet secrets with authenticated AES-GCM.
// PBKDF2 parameters and wire fields stay centralized so legacy linking-key and
// v2 wallet-material records remain interoperable with their own readers.

import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'

const PBKDF2_ITERATIONS = 210_000

const deriveAesKeyFromPassword = (password: string, salt: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle
    .importKey('raw', utf8ToBytes(password), 'PBKDF2', false, ['deriveKey'])
    .then((baseKey) =>
      crypto.subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt: new Uint8Array(salt),
          iterations: PBKDF2_ITERATIONS,
          hash: 'SHA-256',
        },
        baseKey,
        {name: 'AES-GCM', length: 256},
        false,
        ['encrypt', 'decrypt'],
      ),
    )

export type EncryptedSecretParts = {
  readonly salt: string
  readonly iv: string
  readonly ciphertext: string
}

export const encryptSecretParts = async (
  value: string,
  password: string,
): Promise<EncryptedSecretParts> => {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aesKey = await deriveAesKeyFromPassword(password, salt)
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({name: 'AES-GCM', iv}, aesKey, utf8ToBytes(value)),
  )
  return {
    salt: bytesToHex(salt),
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(ciphertext),
  }
}

export const decryptSecretParts = async (
  parts: EncryptedSecretParts,
  password: string,
): Promise<string> => {
  const salt = hexToBytes(parts.salt)
  const iv = hexToBytes(parts.iv)
  const aesKey = await deriveAesKeyFromPassword(password, salt)
  const plaintext = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv},
    aesKey,
    hexToBytes(parts.ciphertext),
  )
  return new TextDecoder().decode(plaintext)
}
