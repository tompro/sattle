// The shared types of the NWC service runtime: the deps the caller
// provides, the changeset the caller's store applies after an op ran, the
// pending-invoice registry entry, and the per-request context the method
// handlers (dispatch.ts, pay.ts, invoices.ts) operate on. Types only -
// no logic, so every other nwc/ module can import from here without
// cycles.

import type {LnurlcashOptions} from 'lnurlcash-kit'

import type {Bearer, NewBearer} from '../types'
import type {NwcConnectionRecord} from '../storage/nwcConnections'
import type {PreparedMint} from '../ops'
import type {CarveResult} from '../ops'
import type {OutputSecretAllocator} from '../ops/allocation'
import type {MintSignatureKeys} from '../ops/shared'
import type {PollOptions} from '../ops/shared'

import type {NwcConnectionInfo} from './connection'
import type {NwcMethod} from './protocol'
import type {NwcTransport} from './transport'

// the state delta the caller's store applies after an op ran: new notes
// to track, existing bearer ids to lock spent. Born-spent notes (a
// freshly carved note that was melted away) are deliberately NOT part of
// it - they were never the wallet's money in a trackable state
export type NwcChangeset = {
  add: NewBearer[]
  markSpent: string[]
}

export type NwcServiceDeps = {
  getBearers: () => Bearer[]
  // the mint make_invoice issues invoices against (the wallet's default
  // mint - NIP-47's make_invoice carries no mint choice)
  getDefaultMint: () => string | null
  assertCurrentOwner: () => void
  // the wallet's durable allocation path (BIP-32 reservation) for every
  // note output secret a request stages
  allocateOutputSecrets: (
    server: string,
    count: number,
    assertOwner: () => void,
  ) => Promise<readonly string[]>
  // trusted current+previous signing keys a landed carve output verifies
  // against - the trusted-mint registry, owner-scoped
  mintSignatureKeys: MintSignatureKeys
  recoverPendingMints: (assertOwner: () => void) => Promise<void>
  persistMintOutput: (note: NewBearer, assertOwner: () => void) => Promise<Bearer>
  discardMintOutput: (staged: Bearer, assertOwner: () => void) => Promise<void>
  setMintOutputRetirement: (
    staged: Bearer,
    retireAfter: number,
    assertOwner: () => void,
  ) => Promise<void>
  reserveMintOutputSource: (
    staged: Bearer,
    sourceId: string,
    recoverySecret: string,
    assertOwner: () => void,
  ) => Promise<void>
  finalizeMintOutput: (staged: Bearer, note: NewBearer, assertOwner: () => void) => Promise<void>
  finalizePaymentReturn: (
    staged: Bearer,
    note: NewBearer,
    assertOwner: () => void,
  ) => Promise<void>
  finalizeSpentMintOutput: (staged: Bearer, assertOwner: () => void) => Promise<void>
  commitCarve: (carve: CarveResult, assertOwner: () => void) => Promise<Bearer>
  applyChangeset: (
    changeset: NwcChangeset,
    connection: NwcConnectionInfo,
    method: NwcMethod,
    assertOwner: () => void,
  ) => Promise<void>
  transport?: NwcTransport
  // kit transport overrides (fetch injection, timeouts)
  kit?: LnurlcashOptions
  // verify-poll budget for pay_invoice outcome classification
  poll?: PollOptions
  // verify-poll budget for the background claim after make_invoice -
  // generous by default: the client pays the invoice whenever it pays it
  claimPoll?: PollOptions
  // background failures (a lost claim, a rejected publish) have no caller
  // to throw to - they surface here
  onError?: (error: unknown, connection: NwcConnectionInfo) => void
  // test hook: pinned clock for event timestamps and expirations
  nowSeconds?: () => number
}

export type PendingInvoice = {
  invoice: string
  paymentHash: string
  // the gross invoiced amount (net + mint fee) - what the payer pays
  amountMsat: number
  description?: string
  createdAt: number // unix seconds
  expiresAt?: number
  prepared: PreparedMint
  stagedOutput: Bearer
  state: 'pending' | 'settled' | 'failed'
  preimage?: string
  settledAt?: number
}

// what a method handler sees of its connection's runtime: the deps, the
// (fresh) connection info - budget updates replace the record, so it's a
// getter, not a snapshot - the invoice registry, and the clock
export type RequestContext = {
  deps: NwcServiceDeps
  connection: () => NwcConnectionInfo
  updateRecord: (record: NwcConnectionRecord) => void
  invoices: Map<string, PendingInvoice>
  nowSeconds: () => number
  assertOwner: () => void
  // Starts service-owned work only while the service accepts new work.
  // Accepted tasks become part of stop's drain before key cleanup.
  startBackground: (work: () => Promise<void>) => boolean
  // fires when the service stops: long OBSERVATION waits (the invoice
  // claim poll) must interrupt themselves on it. Work that has already
  // reached a fund-critical commit must NOT consult it - stop awaits
  // those tasks through its drain
  stopSignal: AbortSignal
}
