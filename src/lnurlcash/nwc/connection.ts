// NWC connections: the model half of the NIP-47 wallet service - creating
// connections, deriving their keys, and the connection-string codec. No
// relay I/O here; the runtime lives in service.ts.
//
// Key material, per connection:
// - the CLIENT keypair: a fresh random secret, handed to the client app
//   exactly once inside the connection string. The wallet stores only its
//   pubkey (NIP-47: the wallet service should not store the secret it
//   generates for the client) - a leaked device backup then can't
//   impersonate a client, and a lost connection string simply means
//   creating a new connection.
// - the WALLET-SERVICE keypair: derived, not generated:
//   sha256(linking key || context || client pubkey), the same construction
//   as nostr/events.ts's deriveBackupKey under a different context string.
//   Deterministic derivation is what lets a restored seed serve its old
//   connections again without any extra backup: the persisted record
//   (client pubkey, relays, budget) re-yields the identical wallet key, so
//   the client keeps talking to the same wallet-service pubkey.
//
// The connection string follows NIP-47 exactly:
//   nostr+walletconnect://<wallet-service-pubkey>?relay=wss://...&secret=<client-secret-hex>

import {sha256} from '@noble/hashes/sha2.js'
import {bytesToHex, hexToBytes, utf8ToBytes} from '@noble/hashes/utils.js'
import {getPublicKey} from 'nostr-tools/pure'

import {linkingPubKeyHex} from '../keys'
import type {NwcBudget, NwcConnectionRecord} from '../storage/nwcConnections'
import {persistNwcConnection} from '../storage/nwcConnections'

const NWC_WALLET_KEY_CONTEXT = 'sattle-nwc-wallet-v1'

const HEX_64 = /^[0-9a-f]{64}$/i

// Deterministic: sha256(linking key || context || client pubkey). The
// result is a secp256k1 secret key used ONLY as this connection's
// wallet-service identity - it signs and decrypts NIP-47 events for this
// one client, nothing else.
export const deriveNwcWalletKey = (linkingPrivKey: Uint8Array, clientPubkey: string): Uint8Array =>
  sha256(
    new Uint8Array([
      ...linkingPrivKey,
      ...utf8ToBytes(NWC_WALLET_KEY_CONTEXT),
      ...hexToBytes(clientPubkey),
    ]),
  )

// the x-only nostr pubkey the client addresses its requests to
export const nwcWalletPubkey = (walletSecretKey: Uint8Array): string =>
  getPublicKey(walletSecretKey)

export type NwcConnectionInfo = {
  record: NwcConnectionRecord
  walletServicePubkey: string
}

// the runtime view of a persisted record: the record plus its re-derived
// wallet-service identity
export const connectionInfoOf = (
  linkingPrivKey: Uint8Array,
  record: NwcConnectionRecord,
): NwcConnectionInfo => ({
  record,
  walletServicePubkey: nwcWalletPubkey(deriveNwcWalletKey(linkingPrivKey, record.clientPubkey)),
})

export type CreatedConnection = NwcConnectionInfo & {
  // shown to the holder exactly once - it carries the client secret,
  // which the wallet deliberately does NOT store
  connectionString: string
}

export type CreateConnectionOptions = {
  relays: string[]
  budget: NwcBudget
  // test hook: a fixed client secret (32 bytes) instead of a random one
  clientSecret?: Uint8Array
  now?: number
}

// Creates and persists a connection. The client secret is random by
// default; the wallet-service key falls out of the derivation above.
export const createConnection = (
  linkingPrivKey: Uint8Array,
  options: CreateConnectionOptions,
): CreatedConnection => {
  if (options.relays.length === 0) {
    throw new Error('A connection needs at least one relay.')
  }
  const clientSecret = options.clientSecret ?? crypto.getRandomValues(new Uint8Array(32))
  const clientPubkey = getPublicKey(clientSecret)
  const ownerId = linkingPubKeyHex(linkingPrivKey)
  const record = persistNwcConnection(ownerId, {
    version: 1,
    ownerId,
    clientPubkey,
    relays: options.relays,
    budget: options.budget,
    spent: {periodStart: options.now ?? Date.now(), msat: 0},
    createdAt: options.now ?? Date.now(),
  })
  const info = connectionInfoOf(linkingPrivKey, record)
  return {
    ...info,
    connectionString: buildConnectionString(
      info.walletServicePubkey,
      bytesToHex(clientSecret),
      record.relays,
    ),
  }
}

export const buildConnectionString = (
  walletServicePubkey: string,
  clientSecretHex: string,
  relays: string[],
): string => {
  const query = relays.map((relay) => `relay=${encodeURIComponent(relay)}`).join('&')
  return `nostr+walletconnect://${walletServicePubkey}?${query}&secret=${clientSecretHex}`
}

export type ParsedConnectionString = {
  walletServicePubkey: string
  clientSecret: string
  relays: string[]
}

// parses a NIP-47 connection string; returns null for anything that isn't
// exactly one (a client-side counterpart of buildConnectionString, here so
// the format has a tested inverse)
export const parseConnectionString = (uri: string): ParsedConnectionString | null => {
  let url: URL
  try {
    url = new URL(uri.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'nostr+walletconnect:') return null
  // the host is the wallet-service pubkey; normalize case so a
  // hand-typed uppercase string still parses (nostr pubkeys are
  // conventionally lowercase hex)
  const walletServicePubkey = url.host.toLowerCase()
  if (!HEX_64.test(walletServicePubkey)) return null
  const secret = url.searchParams.get('secret')
  if (!secret || !HEX_64.test(secret)) return null
  const relays = url.searchParams.getAll('relay').filter((relay) => /^wss?:\/\//.test(relay))
  if (relays.length === 0) return null
  return {walletServicePubkey, clientSecret: secret.toLowerCase(), relays}
}
