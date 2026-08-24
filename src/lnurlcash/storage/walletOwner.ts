// Wallet owner marker. The saved linking-key record (and, in later work,
// every credential-ish record: passkey slots, NWC connections, the
// trusted-mint registry) carries an ownerId binding it to exactly one
// wallet identity, so a restored or foreign wallet can never inherit
// residue from a previous one and a stale tab cannot act for a replaced
// owner.
//
// The canonical ownerId is linkingPubKeyHex(linkingKey): the lowercase
// 66-char compressed secp256k1 pubkey hex of the wallet's LUD-05 linking
// key. It is a PUBLIC value - knowing it proves nothing. That is why a
// marker may only be WRITTEN from a freshly derived or freshly proven key
// (a new save, or ensureSavedKeyOwner after a successful unlock) and never
// copied from a backup file, a credential id, or any other stored claim.
//
// Failure model: localStorage is hand-editable and backups are hostile
// input, so a marker is never trusted on presence alone. Anything that is
// not byte-exactly a valid compressed-pubkey hex - wrong length, wrong
// case, non-hex, off-curve, non-string - is rejected by its owning schema.
// Only a record with no ownership metadata at all is legacy ownerless data;
// malformed or future metadata must never be downgraded into that adoptable
// path.

import {secp256k1} from '@noble/curves/secp256k1.js'

// strict shape AND curve check: exactly what linkingPubKeyHex can produce
export const isWalletOwnerId = (ownerId: unknown): ownerId is string => {
  if (typeof ownerId !== 'string' || !/^0[23][0-9a-f]{64}$/.test(ownerId)) {
    return false
  }
  try {
    secp256k1.Point.fromHex(ownerId)
    return true
  } catch {
    return false
  }
}
