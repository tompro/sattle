import {mnemonicToSeedSync, generateMnemonic, validateMnemonic} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {HDKey, HARDENED_OFFSET} from '@scure/bip32'
import {hmac} from '@noble/hashes/hmac.js'
import {sha256} from '@noble/hashes/sha2.js'
import {secp256k1} from '@noble/curves/secp256k1.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'

import {
  parseStoredSecret,
  stampStoredSecretOwner,
  storedSecretClaimedOwnerId,
  storedSecretOwnerId,
  stripStoredSecretOwner,
  STORED_SECRET_VERSION,
  type StoredSecret,
} from './storage/storedSecret'
import {LINKING_KEY_STORAGE_KEY} from './storage/walletOwnerEvents'

export {isValidStoredSecret} from './storage/storedSecret'
export type {StoredSecret} from './storage/storedSecret'

// The wallet's identity is derived against this fixed domain rather than
// window.location.hostname, so the same seed phrase always yields the same
// linking key (and thus decrypts the same bearer tokens) no matter where
// this static build happens to be hosted - github.io, a mirror, file://.
export const WALLET_DOMAIN = 'sattle'

export const generateSeedPhrase = (): string => generateMnemonic(wordlist, 128)

export const isValidSeedPhrase = (phrase: string): boolean =>
  validateMnemonic(phrase.trim().toLowerCase(), wordlist)

const readUint32BE = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]) >>>
  0

// LUD-05: BIP32-based linking-key derivation, same scheme as lnurl_server -
// a seed restored there or here produces the same identity for a given domain
export const deriveLud05LinkingKey = (seedPhrase: string, domain: string): Uint8Array => {
  const seed = mnemonicToSeedSync(seedPhrase.trim().toLowerCase())
  const master = HDKey.fromMasterSeed(seed)

  const hashingKeyNode = master.derive("m/138'/0")
  if (!hashingKeyNode.privateKey) throw new Error('Could not derive hashing key')
  const suffix = lud05PathSuffix(hashingKeyNode.privateKey, domain)

  // path suffix longs are raw BIP32 child indices: whether each level ends up
  // hardened depends solely on its own magnitude (>= 2^31), never forced
  let node = master.deriveChild(138 + HARDENED_OFFSET)
  for (const index of suffix) {
    node = node.deriveChild(index)
  }
  if (!node.privateKey) throw new Error('Could not derive linking key')
  return node.privateKey
}

// the HMAC half of the derivation, split out so the LUD-05 test vector
// (which starts from a fixed hashingPrivKey, not a seed phrase) can pin it
// directly - see keys.test.ts
export const lud05PathSuffix = (hashingKey: Uint8Array, domain: string): number[] => {
  const material = hmac(sha256, hashingKey, utf8ToBytes(domain))
  return [0, 4, 8, 12].map((i) => readUint32BE(material, i))
}

export const deriveWalletLinkingKey = (seedPhrase: string): Uint8Array =>
  deriveLud05LinkingKey(seedPhrase, WALLET_DOMAIN)

export const linkingPubKeyHex = (linkingPrivKey: Uint8Array): string =>
  bytesToHex(secp256k1.getPublicKey(linkingPrivKey, true))

// Encrypted-at-rest localStorage secret, same shape as lnurl_server's: the
// stored value is either plaintext or, if the holder opted in with a
// password, AES-GCM ciphertext keyed by a PBKDF2 stretch of that password -
// GCM's auth tag doubles as the "wrong password" check on decrypt.
const PBKDF2_ITERATIONS = 210_000

const readSecret = (storageKey: string): StoredSecret | null => {
  const raw = localStorage.getItem(storageKey)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parseStoredSecret(parsed)?.secret ?? null
  } catch {
    return null
  }
}

const deriveAesKeyFromPassword = (password: string, salt: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle
    .importKey('raw', utf8ToBytes(password), 'PBKDF2', false, ['deriveKey'])
    .then((baseKey) =>
      crypto.subtle.deriveKey(
        // the copy pins the TS type to Uint8Array<ArrayBuffer> - hexToBytes
        // returns Uint8Array<ArrayBufferLike>, which BufferSource rejects
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
  salt: string
  iv: string
  ciphertext: string
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

// rejects (WebCrypto's own auth-tag check) if the password is wrong
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

// The linking key is the only secret this wallet persists - the seed phrase
// it was derived from is shown once at setup and never stored. Everything
// else at rest (the bearer tokens) is encrypted with a key derived from it,
// so protecting this one record with a password protects the whole wallet.
//
// The record also carries an ownerId marker: the lowercase compressed
// pubkey hex of the key itself (storage/walletOwner.ts), binding every
// other wallet-owned record (passkeys, NWC, trusted mints) to this exact
// identity. Failure modes of the marker API:
// - new writes always carry the marker derived from the key being saved;
// - a record restored from a backup/relay is installed OWNERLESS - its
//   file-carried marker is an unproven claim and is stripped on restore;
// - an ownerless legacy record stays usable but cannot establish ownership;
//   malformed or unsupported owner-bearing metadata rejects the whole record;
// - ensureSavedKeyOwner stamps the marker after the caller proved the key
//   (successful password/plaintext unlock or matching biometric unwrap),
//   preserving ciphertext byte-for-byte; it refuses to restamp a record
//   already owned by a different valid owner, and refuses a key that
//   contradicts a plaintext record.
export const savedKeyExists = (): boolean => readSecret(LINKING_KEY_STORAGE_KEY) !== null

export const savedKeyIsEncrypted = (): boolean => readSecret(LINKING_KEY_STORAGE_KEY)?.enc === true

export const getSavedLinkingKeyStored = (): StoredSecret | null =>
  readSecret(LINKING_KEY_STORAGE_KEY)

// the proven owner of the saved key, or null when there is no record or it
// carries no current version-1 marker (ownerless or compatible unversioned)
export const savedKeyOwnerId = (): string | null => {
  const stored = readSecret(LINKING_KEY_STORAGE_KEY)
  return stored === null ? null : storedSecretOwnerId(stored)
}

// Compares only against an owner freshly derived from a linking key. An
// ownerless or unversioned saved marker never matches.
export const savedKeyOwnerMatches = (linkingKey: Uint8Array): boolean =>
  savedKeyOwnerId() === linkingPubKeyHex(linkingKey)

// Stamps the owner marker onto the existing record. Call ONLY with the key
// just proven against this record (decryptSavedLinkingKey / a plaintext
// read / a biometric unwrap whose stored pubkey matched) - the marker is
// derived from that key, never from a stored claim. No saved record or an
// already-correct marker: no write. A DIFFERENT valid owner, or a key that
// contradicts a plaintext record, throws and leaves storage untouched.
export const ensureSavedKeyOwner = (linkingKey: Uint8Array): void => {
  const stored = readSecret(LINKING_KEY_STORAGE_KEY)
  if (stored === null) return
  const ownerId = linkingPubKeyHex(linkingKey)
  if (stored.enc === false && stored.value.toLowerCase() !== bytesToHex(linkingKey)) {
    throw new Error('Proven key does not match the saved wallet key.')
  }
  const claimedOwnerId = storedSecretClaimedOwnerId(stored)
  if (storedSecretOwnerId(stored) === ownerId) return
  if (claimedOwnerId !== null && claimedOwnerId !== ownerId) {
    throw new Error('Saved wallet key is owned by a different wallet.')
  }
  localStorage.setItem(
    LINKING_KEY_STORAGE_KEY,
    JSON.stringify(stampStoredSecretOwner(stored, ownerId)),
  )
}

export const getPlainLinkingKey = (): Uint8Array | null => {
  const stored = readSecret(LINKING_KEY_STORAGE_KEY)
  if (stored === null || stored.enc === true) return null
  return hexToBytes(stored.value)
}

export const saveLinkingKey = async (
  linkingPrivKey: Uint8Array,
  password?: string,
): Promise<void> => {
  const hex = bytesToHex(linkingPrivKey)
  const ownerId = linkingPubKeyHex(linkingPrivKey)
  if (!password) {
    localStorage.setItem(
      LINKING_KEY_STORAGE_KEY,
      JSON.stringify({enc: false, value: hex, ownerId, version: STORED_SECRET_VERSION}),
    )
    return
  }
  const parts = await encryptSecretParts(hex, password)
  localStorage.setItem(
    LINKING_KEY_STORAGE_KEY,
    JSON.stringify({enc: true, ...parts, ownerId, version: STORED_SECRET_VERSION}),
  )
}

// installs a record from a backup/relay. Any ownerId it carries is an
// unproven claim by whoever produced that file, so the marker is stripped
// here - the first proven unlock re-establishes it (see the failure-model
// comment above)
export const restoreLinkingKeyStored = (stored: StoredSecret): void => {
  localStorage.setItem(LINKING_KEY_STORAGE_KEY, JSON.stringify(stripStoredSecretOwner(stored)))
}

export const decryptSavedLinkingKey = async (password: string): Promise<Uint8Array> => {
  const stored = readSecret(LINKING_KEY_STORAGE_KEY)
  if (!stored || !stored.enc) throw new Error('No encrypted linking key saved.')
  return hexToBytes(await decryptSecretParts(stored, password))
}

export const clearSavedLinkingKey = (): void => {
  localStorage.removeItem(LINKING_KEY_STORAGE_KEY)
}

// The bearer-encryption key is derived (not random): sha256 over the linking
// key plus a fixed context string. Deterministic derivation is what makes
// backup/restore work with nothing but the seed phrase - restore the seed on
// a fresh device and every previously exported ciphertext decrypts again.
const BEARER_KEY_CONTEXT = 'lnurlcash-bearer-encryption-v1'

export const deriveBearerAesKey = (linkingPrivKey: Uint8Array): Promise<CryptoKey> => {
  const material = sha256(new Uint8Array([...linkingPrivKey, ...utf8ToBytes(BEARER_KEY_CONTEXT)]))
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export type EncryptedRecordParts = {iv: string; ciphertext: string}

export const encryptRecord = async (
  aesKey: CryptoKey,
  value: object,
): Promise<EncryptedRecordParts> => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({name: 'AES-GCM', iv}, aesKey, utf8ToBytes(JSON.stringify(value))),
  )
  return {iv: bytesToHex(iv), ciphertext: bytesToHex(ciphertext)}
}

export const decryptRecord = async (
  aesKey: CryptoKey,
  parts: EncryptedRecordParts,
): Promise<unknown> => {
  const plaintext = await crypto.subtle.decrypt(
    {name: 'AES-GCM', iv: hexToBytes(parts.iv)},
    aesKey,
    hexToBytes(parts.ciphertext),
  )
  return JSON.parse(new TextDecoder().decode(plaintext))
}
