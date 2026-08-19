// Passkey-slot persistence: one localStorage record holding every passkey
// wrap of the linking key (see passkeys.ts). Slots are public metadata plus
// AES-GCM wrapped keys - a wrapped blob is useless without the passkey's
// authenticator, so this sits next to the plaintext registries. Read/write
// are exported bare; callers serialize read-modify-write cycles with
// withStorageLock, same convention as bearers.ts.

// the encrypted half of a slot: the linking key under a passkey wrap key
export type PasskeyWrap = {
  hkdfSalt: string // hex, 16 bytes - per-slot HKDF salt
  iv: string // hex, 12 bytes
  wrappedKey: string // hex, AES-GCM ciphertext of the 32-byte linking key
}

export type PasskeySlot = PasskeyWrap & {
  credentialId: string // hex of the raw WebAuthn credential id
  createdAt: number
  name?: string // optional holder label ('laptop', 'phone', ...)
}

export const PASSKEY_SLOTS_STORAGE_KEY = 'sattle_passkey_slots'

// strict shape check, same spirit as keys.ts's isValidStoredSecret:
// localStorage content is not trustworthy input (hand-edited, restored
// backups), so slots are validated before use
const isValidPasskeySlot = (slot: unknown): slot is PasskeySlot => {
  if (typeof slot !== 'object' || slot === null) return false
  const s = slot as Record<string, unknown>
  return (
    typeof s.credentialId === 'string' &&
    s.credentialId.length > 0 &&
    s.credentialId.length % 2 === 0 &&
    /^[0-9a-f]+$/i.test(s.credentialId) &&
    typeof s.hkdfSalt === 'string' &&
    /^[0-9a-f]{32}$/i.test(s.hkdfSalt) &&
    typeof s.iv === 'string' &&
    /^[0-9a-f]{24}$/i.test(s.iv) &&
    typeof s.wrappedKey === 'string' &&
    s.wrappedKey.length > 0 &&
    s.wrappedKey.length % 2 === 0 &&
    /^[0-9a-f]+$/i.test(s.wrappedKey) &&
    typeof s.createdAt === 'number' &&
    (s.name === undefined || typeof s.name === 'string')
  )
}

// malformed entries are dropped, not thrown on - one corrupted slot must
// not take the remaining passkeys down with it
export const readPasskeySlots = (): PasskeySlot[] => {
  const raw = localStorage.getItem(PASSKEY_SLOTS_STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isValidPasskeySlot) : []
  } catch {
    return []
  }
}

export const hasPasskeySlots = (): boolean => readPasskeySlots().length > 0

export const writePasskeySlots = (slots: PasskeySlot[]): void => {
  localStorage.setItem(PASSKEY_SLOTS_STORAGE_KEY, JSON.stringify(slots))
}
