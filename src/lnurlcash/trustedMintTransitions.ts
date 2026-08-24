// Pure trusted-mint registry transitions. Persistence serializes these
// operations, while this module keeps pinning and backup policy auditable.

import type {TrustedMint, TrustedMintNodeInfo, TrustKeyResult} from './trustedMints'

const PUBKEY_PATTERN = /^[0-9a-f]{66}$/

export const isValidMintPubkey = (value: string): boolean =>
  PUBKEY_PATTERN.test(value.toLowerCase())

export type MintTransition<T> = {
  readonly mints: TrustedMint[]
  readonly result: T
  readonly changed: boolean
}

type MintKeyInput = {
  readonly server: string
  readonly mintPubkey: string
}

type AddMintInput = MintKeyInput & {
  readonly nodeInfo?: TrustedMintNodeInfo
}

const unchanged = <T>(mints: TrustedMint[], result: T): MintTransition<T> => ({
  mints,
  result,
  changed: false,
})

const changed = <T>(mints: TrustedMint[], result: T): MintTransition<T> => ({
  mints,
  result,
  changed: true,
})

export const lockMint = (
  mints: TrustedMint[],
  input: MintKeyInput,
): MintTransition<TrustKeyResult> => {
  const key = input.mintPubkey.trim().toLowerCase()
  if (!input.server || !isValidMintPubkey(key)) {
    return unchanged(mints, 'unchanged')
  }
  const existing = mints.find((mint) => mint.server === input.server)
  if (!existing) {
    return changed(
      [
        ...mints,
        {
          server: input.server,
          mintPubkey: key,
          addedAt: Date.now(),
          locked: true,
        },
      ],
      'added',
    )
  }
  if (existing.mintPubkey === key) {
    if (existing.locked && !existing.unconfirmed) {
      return unchanged(mints, 'unchanged')
    }
    return changed(
      mints.map((mint) =>
        mint.server === input.server ? {...mint, locked: true, unconfirmed: undefined} : mint,
      ),
      'unchanged',
    )
  }
  if (existing.pendingMintPubkey === key) {
    return unchanged(mints, 'rekey-pending')
  }
  return changed(
    mints.map((mint) => (mint.server === input.server ? {...mint, pendingMintPubkey: key} : mint)),
    'rekey-pending',
  )
}

export const grandfatherMint = (
  mints: TrustedMint[],
  input: MintKeyInput,
): MintTransition<TrustKeyResult> => {
  const key = input.mintPubkey.trim().toLowerCase()
  if (!input.server || !isValidMintPubkey(key)) {
    return unchanged(mints, 'unchanged')
  }
  const existing = mints.find((mint) => mint.server === input.server)
  if (!existing) {
    return changed(
      [
        ...mints,
        {
          server: input.server,
          mintPubkey: key,
          addedAt: Date.now(),
          locked: false,
          unconfirmed: true,
        },
      ],
      'added',
    )
  }
  if (existing.mintPubkey === key) return unchanged(mints, 'unchanged')
  if (existing.pendingMintPubkey === key) {
    return unchanged(mints, 'rekey-pending')
  }
  return changed(
    mints.map((mint) => (mint.server === input.server ? {...mint, pendingMintPubkey: key} : mint)),
    'rekey-pending',
  )
}

export const addMint = (
  mints: TrustedMint[],
  input: AddMintInput,
): MintTransition<TrustKeyResult> => {
  const server = input.server.trim()
  const key = input.mintPubkey.trim().toLowerCase()
  if (!server) throw new Error('Enter a server.')
  if (!isValidMintPubkey(key)) {
    throw new Error('Signing key must be a 33-byte compressed pubkey (66 hex characters).')
  }
  const existing = mints.find((mint) => mint.server === server)
  if (!existing) {
    return changed(
      [
        ...mints,
        {
          server,
          mintPubkey: key,
          addedAt: Date.now(),
          locked: false,
          ...input.nodeInfo,
        },
      ],
      'added',
    )
  }
  if (existing.mintPubkey === key) {
    return changed(
      mints.map((mint) =>
        mint.server === server ? {...mint, ...input.nodeInfo, unconfirmed: undefined} : mint,
      ),
      'unchanged',
    )
  }
  return changed(
    mints.map((mint) =>
      mint.server === server ? {...mint, pendingMintPubkey: key, ...input.nodeInfo} : mint,
    ),
    'rekey-pending',
  )
}

export const confirmMintRekey = (mints: TrustedMint[], server: string): MintTransition<void> => {
  const pending = mints.find((mint) => mint.server === server)?.pendingMintPubkey
  if (!pending) return unchanged(mints, undefined)
  return changed(
    mints.map((mint) =>
      mint.server === server
        ? {
            ...mint,
            mintPubkey: pending,
            pendingMintPubkey: undefined,
            unconfirmed: undefined,
          }
        : mint,
    ),
    undefined,
  )
}

export const dismissMintRekey = (mints: TrustedMint[], server: string): MintTransition<void> => {
  if (!mints.some((mint) => mint.server === server)) {
    return unchanged(mints, undefined)
  }
  return changed(
    mints.map((mint) => (mint.server === server ? {...mint, pendingMintPubkey: undefined} : mint)),
    undefined,
  )
}

export const cacheMintNodeInfo = (
  mints: TrustedMint[],
  server: string,
  nodeInfo: TrustedMintNodeInfo,
): MintTransition<void> => {
  if (!mints.some((mint) => mint.server === server)) {
    return unchanged(mints, undefined)
  }
  return changed(
    mints.map((mint) => (mint.server === server ? {...mint, ...nodeInfo} : mint)),
    undefined,
  )
}

export const removeMint = (mints: TrustedMint[], server: string): MintTransition<void> => {
  const existing = mints.find((mint) => mint.server === server)
  if (!existing) return unchanged(mints, undefined)
  if (existing.locked) {
    throw new Error("Can't remove - you hold a bearer note from this mint.")
  }
  return changed(
    mints.filter((mint) => mint.server !== server),
    undefined,
  )
}

export const clearMints = (): MintTransition<void> => changed([], undefined)
