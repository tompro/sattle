import type {MintAddressInfo} from 'lnurlcash-kit'

// allow: SIZE_OK — one indivisible registry: every operation below reads
// and writes the same pinned-key cache through the same persist/notify
// path, and the file is a deliberate verbatim-behavior port of
// lnurl-wallet's trustedMints.ts so the two wallets' pinning semantics
// stay auditable side by side.

// A mint's signing key (LUD-25 Offline verification's `mintPubkey`) - not a
// secret, just a public identity, so this is plain unencrypted localStorage,
// unlike bearer notes. Framework-free (the Pinia mints store subscribes via
// onTrustedMintsChange) so plain utility code - ops.ts's flows in
// particular - can touch it too, not just UI components.
export type TrustedMint = {
  server: string
  mintPubkey: string
  addedAt: number
  // true once a bearer is held from this server - trust then follows
  // holding funds there, not a standalone opinion, so it can't be revoked
  // by deleting it here (see removeTrustedMint)
  locked: boolean
  // true when this pin came from a backup file or a stored bearer's cached
  // key rather than a live response from the server itself (see
  // mergeTrustedMints / grandfatherTrustedMint): excluded from offline
  // signature verification until a live response from this server
  // advertises the same key (any lockTrustedMint/addTrustedMint match
  // clears it) - a crafted backup could otherwise plant a pin for a mint it
  // controls and forge "signed" badges on worthless notes
  unconfirmed?: boolean
  // a DIFFERENT signing key this mint has since advertised (via a note
  // refresh, a lookup, etc) - staged for explicit holder review, never
  // auto-applied. The pinned mintPubkey above stays authoritative until
  // confirmTrustedMintRekey promotes this one; a key that silently rotated
  // would defeat the entire pinning model (a compromised mint could sign
  // unbacked notes that then show the "signed" badge).
  pendingMintPubkey?: string
  // best-effort node identity/capacity, cached from the mint-address
  // discovery endpoint (see the kit's fetchMintAddress) purely for display -
  // absent for a mint that doesn't support it, or one trusted before this
  // wallet learned to ask. Never used for anything security-relevant;
  // mintPubkey above remains the only thing a note's signature is ever
  // checked against.
  nodeAlias?: string
  nodeColor?: string
  nodeCapacityMsat?: number
  nodeNumChannels?: number
  nodeNumPeers?: number
  // the local-part this mint was actually reached at ("mint" out of
  // "mint@host" - see the kit's lightningAddressUsername), cached so a
  // later quick-select can reconstruct the exact address instead of
  // guessing "mint@<server>" for a mint that uses a different one. Absent
  // for a mint only ever looked up as a bech32 LNURL, which has no such
  // concept.
  username?: string
}

// the subset of TrustedMint that's cacheable display metadata, as opposed
// to the server/mintPubkey/addedAt/locked fields every entry has regardless
export type TrustedMintNodeInfo = {
  nodeAlias?: string
  nodeColor?: string
  nodeCapacityMsat?: number
  nodeNumChannels?: number
  nodeNumPeers?: number
  username?: string
}

// distills a mint-address lookup (see the kit's fetchMintAddress) down to
// just the cacheable display fields above - shared by every mint discovery
// flow, so all of them cache node info the same way rather than duplicating
// this shape-narrowing themselves. `username` is independent of whether the
// mint-address endpoint itself succeeded - it's cached even when info is
// null, since it comes straight from whichever payRequest URL was actually
// resolved, not from that endpoint's response.
export const mintAddressCacheInfo = (
  info: MintAddressInfo | null,
  username: string | null
): TrustedMintNodeInfo | undefined => {
  if (!info && !username) return undefined
  return {
    nodeAlias: info?.nodeAlias,
    nodeColor: info?.nodeColor,
    nodeCapacityMsat: info?.nodeCapacityMsat,
    nodeNumChannels: info?.nodeNumChannels,
    nodeNumPeers: info?.nodeNumPeers,
    username: username ?? undefined
  }
}

// A small curated list of known public mints, for a one-click quick start -
// unrelated to whether any given entry ends up in the trusted-mints
// registry above (appearing here says nothing about a mint's signing key or
// whether this wallet has ever used it). The bare "@domain" form rather
// than spelling out "mint@domain" - still resolves to the exact same
// address, just how these mints tend to actually display their own.
// Ported verbatim from lnurl-wallet/src/trustedMints.ts.
export const PUBLIC_MINTS = [
  '@mint.600.wtf',
  '@lnurl.21mint.me',
  '@mint.forgesworn.dev',
  '@lnurl.21linz.at',
  '@minty.exe.xyz'
]

const STORAGE_KEY = 'sattle_trusted_mints'

// 33-byte compressed secp256k1 pubkey, hex
const PUBKEY_PATTERN = /^[0-9a-f]{66}$/

const readStored = (): TrustedMint[] => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // shape-check every entry - this is the wallet's own persisted state
    // (so locked/pendingMintPubkey/unconfirmed are all kept), but a
    // tampered or corrupt record must not plant junk entries
    return parsed.filter(
      (m): m is TrustedMint =>
        typeof m?.server === 'string' &&
        typeof m?.mintPubkey === 'string' &&
        PUBKEY_PATTERN.test(m.mintPubkey.toLowerCase()) &&
        typeof m?.addedAt === 'number' &&
        typeof m?.locked === 'boolean'
    )
  } catch {
    return []
  }
}

// lazily initialized on first access: importing this module must not touch
// localStorage (plain-Node test environments have none until stubbed)
let cache: TrustedMint[] | null = null
const readCache = (): TrustedMint[] => {
  cache ??= readStored()
  return cache
}
const listeners = new Set<(mints: TrustedMint[]) => void>()

// the Pinia mints store subscribes here to mirror the registry into
// reactive state; returns the unsubscribe
export const onTrustedMintsChange = (
  listener: (mints: TrustedMint[]) => void
): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const readTrustedMints = (): TrustedMint[] => readCache()

const persist = (mints: TrustedMint[]): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(mints))
  cache = mints
  for (const listener of listeners) listener(mints)
}

export const isMintTrusted = (server: string): boolean =>
  readCache().some(m => m.server === server)

export const getTrustedMintPubkey = (server: string): string | null =>
  readCache().find(m => m.server === server && !m.unconfirmed)?.mintPubkey ?? null

// true when a server has a pin that came from a file/storage rather than a
// live response (see TrustedMint.unconfirmed) - callers should treat a
// bearer's own cached mintPubkey for such a server as equally
// uncorroborated
export const isMintUnconfirmed = (server: string): boolean =>
  readCache().some(m => m.server === server && m.unconfirmed)

// this mint's self-reported node color, for tinting its notes' background -
// purely cosmetic. Mint-supplied, so it's only ever handed out as a plain
// hex color - anything else (a style sink can take far more than colors) is
// treated as absent
export const getTrustedMintNodeColor = (server: string): string | null => {
  const color = readCache().find(m => m.server === server)?.nodeColor
  return color && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color) ? color : null
}

// the exact Lightning Address this mint was last reached at (see
// TrustedMint.username), for a quick-select that reconstructs it instead of
// guessing "mint@<server>" - null for a mint with no cached username
// (looked up as a bech32 LNURL, or trusted before this wallet learned to
// remember one)
export const getTrustedMintAddress = (server: string): string | null => {
  const username = readCache().find(m => m.server === server)?.username
  return username ? `${username}@${server}` : null
}

// what a lock/add attempt did with the advertised key - 'rekey-pending' is
// the security-relevant one: the mint advertised a DIFFERENT key than the
// pinned one, which was staged for review (pendingMintPubkey) instead of
// silently replacing it. Callers should surface that loudly.
export type TrustKeyResult = 'added' | 'unchanged' | 'rekey-pending'

// Called whenever this wallet ends up holding (or already holds) a bearer
// from `server` - minting, receiving, splitting, merging all route through
// the wallet store's addBearers/updateBearer, which is where this gets
// called from. Per "a mint you have a bearer from is trusted by default",
// this never asks and can't be refused - it silently trusts (or upgrades an
// already-trusted-but-unlocked entry) and locks it against removal. The one
// thing it never does silently is CHANGE the pinned key: a differing
// advertised key is staged as pendingMintPubkey for the holder to confirm
// or dismiss (see confirmTrustedMintRekey).
export const lockTrustedMint = (
  server: string,
  mintPubkey: string
): TrustKeyResult => {
  const key = mintPubkey.trim().toLowerCase()
  if (!server || !PUBKEY_PATTERN.test(key)) return 'unchanged'
  const existing = readCache().find(m => m.server === server)
  if (existing) {
    if (existing.mintPubkey === key) {
      if (existing.locked && !existing.unconfirmed) return 'unchanged'
      // a match here is a live response from the server advertising this
      // exact key - it corroborates an unconfirmed (file-sourced) pin
      persist(
        readCache().map(m =>
          m.server === server ? {...m, locked: true, unconfirmed: undefined} : m
        )
      )
      return 'unchanged'
    }
    if (existing.pendingMintPubkey === key) return 'rekey-pending'
    persist(
      readCache().map(m => (m.server === server ? {...m, pendingMintPubkey: key} : m))
    )
    return 'rekey-pending'
  }
  persist([...readCache(), {server, mintPubkey: key, addedAt: Date.now(), locked: true}])
  return 'added'
}

// unlock-time grandfathering of the mints behind already-stored bearers -
// the key claims come from local storage, not a live response, so an
// unknown server is added unlocked AND unconfirmed (excluded from signature
// verification until corroborated live, see TrustedMint.unconfirmed), and
// an existing entry is never locked or confirmed here. A differing claim
// still stages a rekey review. Live bearer operations go through
// lockTrustedMint instead, which is what corroborates and re-locks.
export const grandfatherTrustedMint = (
  server: string,
  mintPubkey: string
): TrustKeyResult => {
  const key = mintPubkey.trim().toLowerCase()
  if (!server || !PUBKEY_PATTERN.test(key)) return 'unchanged'
  const existing = readCache().find(m => m.server === server)
  if (existing) {
    if (existing.mintPubkey === key) return 'unchanged'
    if (existing.pendingMintPubkey === key) return 'rekey-pending'
    persist(
      readCache().map(m => (m.server === server ? {...m, pendingMintPubkey: key} : m))
    )
    return 'rekey-pending'
  }
  persist([
    ...readCache(),
    {server, mintPubkey: key, addedAt: Date.now(), locked: false, unconfirmed: true}
  ])
  return 'added'
}

// Manual add from the mints settings, or a user-confirmed first encounter -
// unlocked, since no bearer necessarily backs it yet. Validates and throws
// instead of silently no-op'ing, since a human is waiting on the result
// either way. `nodeInfo` is whatever the mint-address lookup (if any)
// turned up alongside this pubkey. Same rule as lockTrustedMint for a
// server already pinned with a DIFFERENT key: staged for review (nodeInfo
// still refreshes - it's display-only), never overwritten in place.
export const addTrustedMint = (
  server: string,
  mintPubkey: string,
  nodeInfo?: TrustedMintNodeInfo
): TrustKeyResult => {
  const trimmedServer = server.trim()
  const key = mintPubkey.trim().toLowerCase()
  if (!trimmedServer) {
    throw new Error('Enter a server.')
  }
  if (!PUBKEY_PATTERN.test(key)) {
    throw new Error(
      'Signing key must be a 33-byte compressed pubkey (66 hex characters).'
    )
  }
  const existing = readCache().find(m => m.server === trimmedServer)
  if (existing) {
    if (existing.mintPubkey === key) {
      // a match here is a live lookup corroborating the pin - it clears an
      // unconfirmed (file-sourced) flag
      persist(
        readCache().map(m =>
          m.server === trimmedServer
            ? {...m, ...nodeInfo, unconfirmed: undefined}
            : m
        )
      )
      return 'unchanged'
    }
    persist(
      readCache().map(m =>
        m.server === trimmedServer
          ? {...m, pendingMintPubkey: key, ...nodeInfo}
          : m
      )
    )
    return 'rekey-pending'
  }
  persist([
    ...readCache(),
    {
      server: trimmedServer,
      mintPubkey: key,
      addedAt: Date.now(),
      locked: false,
      ...nodeInfo
    }
  ])
  return 'added'
}

// the holder confirms a mint's advertised new signing key - the pending key
// becomes the pinned one. Legitimate rotations (a mint moving to a new
// node) go through here; nothing else ever replaces a pin.
export const confirmTrustedMintRekey = (server: string): void => {
  const existing = readCache().find(m => m.server === server)
  if (!existing?.pendingMintPubkey) return
  const pending = existing.pendingMintPubkey
  persist(
    readCache().map(m =>
      m.server === server
        ? {...m, mintPubkey: pending, pendingMintPubkey: undefined, unconfirmed: undefined}
        : m
    )
  )
}

// the holder rejects the advertised new key - the staged candidate is
// dropped, the original pin stays. Worth doing only when the change is
// unexpected; the old key stays authoritative either way until confirmed.
export const dismissTrustedMintRekey = (server: string): void => {
  if (!readCache().some(m => m.server === server)) return
  persist(
    readCache().map(m =>
      m.server === server ? {...m, pendingMintPubkey: undefined} : m
    )
  )
}

// refreshes just the cached display info for a server already in the list -
// never touches mintPubkey/addedAt/locked, and no-ops for a server that
// isn't trusted yet (that's addTrustedMint's job, which takes the same info
// directly alongside the pubkey it's trusting for the first time). Called
// opportunistically whenever a lookup re-discovers a mint address for a
// mint this wallet already trusts, so the cache doesn't just freeze at
// whatever was known the moment trust was first established.
export const cacheTrustedMintNodeInfo = (
  server: string,
  nodeInfo: TrustedMintNodeInfo
): void => {
  if (!readCache().some(m => m.server === server)) return
  persist(readCache().map(m => (m.server === server ? {...m, ...nodeInfo} : m)))
}

// only succeeds for entries not backed by a held bearer - see
// TrustedMint.locked
export const removeTrustedMint = (server: string): void => {
  const entry = readCache().find(m => m.server === server)
  if (!entry) return
  if (entry.locked) {
    throw new Error("Can't remove - you hold a bearer note from this mint.")
  }
  persist(readCache().filter(m => m.server !== server))
}

// wipes the whole registry - part of forgetting a wallet: nothing about a
// wallet's mints (including otherwise-irremovable locked pins) should
// linger on the device after it
export const clearTrustedMints = (): void => {
  localStorage.removeItem(STORAGE_KEY)
  cache = []
  for (const listener of listeners) listener([])
}

// merges a backup's trusted mints in by server - a server already known on
// this device keeps its own current entry rather than being overwritten by
// the backup's (possibly stale) copy. Three fields never come across from a
// file: `locked` (a crafted backup could otherwise plant irremovable junk
// entries - real locks re-establish themselves from held bearers on live
// operations anyway) and `pendingMintPubkey` (a key rotation must be
// re-detected from the mint's own live responses, never staged by a file) -
// and every merged entry is marked `unconfirmed`, keeping it out of offline
// signature verification until a live response from that server advertises
// the same key (a crafted backup could otherwise forge "signed" badges)
export const mergeTrustedMints = (incoming: TrustedMint[]): number => {
  const knownServers = new Set(readCache().map(m => m.server))
  const merged = [...readCache()]
  let added = 0
  for (const mint of incoming) {
    if (
      typeof mint?.server !== 'string' ||
      typeof mint?.mintPubkey !== 'string' ||
      typeof mint?.addedAt !== 'number' ||
      !PUBKEY_PATTERN.test(mint.mintPubkey.toLowerCase())
    ) {
      continue
    }
    if (knownServers.has(mint.server)) continue
    merged.push({
      server: mint.server,
      mintPubkey: mint.mintPubkey.toLowerCase(),
      addedAt: mint.addedAt,
      locked: false,
      unconfirmed: true,
      nodeAlias: typeof mint.nodeAlias === 'string' ? mint.nodeAlias : undefined,
      nodeColor: typeof mint.nodeColor === 'string' ? mint.nodeColor : undefined,
      nodeCapacityMsat:
        typeof mint.nodeCapacityMsat === 'number'
          ? mint.nodeCapacityMsat
          : undefined,
      nodeNumChannels:
        typeof mint.nodeNumChannels === 'number'
          ? mint.nodeNumChannels
          : undefined,
      nodeNumPeers:
        typeof mint.nodeNumPeers === 'number' ? mint.nodeNumPeers : undefined,
      username: typeof mint.username === 'string' ? mint.username : undefined
    })
    knownServers.add(mint.server)
    added++
  }
  if (added > 0) persist(merged)
  return added
}
