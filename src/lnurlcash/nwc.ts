// NWC (Nostr Wallet Connect, NIP-47): the wallet-SERVICE side. Clients
// (Alby-style apps) hold a connection string and talk to this wallet over
// public relays with end-to-end-encrypted request/response events; this
// engine validates, decrypts, dispatches onto the ops engine and answers.
//
// FOREGROUND-ONLY, by design: the service runs only while the app is open
// and the wallet unlocked (the wallet-service keys derive from the linking
// key, which only exists in memory then). There is no background runner
// and no push channel: requests sent while the app is closed wait on the
// relay, and any request older than ten minutes when it finally arrives
// is DROPPED UNANSWERED rather than executed late (a pay_invoice executed
// after the client gave up could double-pay). An always-on sattle would
// need a headless signer holding a derived key - deliberately out of
// scope for the PWA.
//
// Framework-free, and no WebSocket is touched at import time: the default
// transport (nostr-tools' SimplePool) is imported lazily on first use,
// and tests inject a fake transport instead. nostr-tools was chosen over
// @getalby/sdk on purpose: the wallet-service side needs exactly event
// signing, NIP-44/NIP-04 crypto and a subscription - all already pinned -
// and the sdk's own websocket management would fight this project's
// injectable-transport pattern.
//
// Split by concern; this façade re-exports everything:
//   nwc/connection.ts  - createConnection, the deterministic
//                        wallet-service key derivation, and the
//                        connection-string codec
//   nwc/protocol.ts    - the pure NIP-47 event codec (validate/decrypt,
//                        build/encrypt), no I/O
//   nwc/transport.ts   - the injectable relay transport
//   nwc/context.ts     - the shared deps/changeset/invoice-registry types
//   nwc/budget.ts      - the per-connection rolling budget
//   nwc/invoices.ts    - the two-phase invoice registry + background claim
//   nwc/pay.ts         - pay_invoice (budget-first melt)
//   nwc/dispatch.ts    - the remaining method handlers + the dispatch switch
//   nwc/service.ts     - startService/stopService: subscriptions and the
//                        per-connection request queues
// Budget/connection persistence lives in storage/nwcConnections.ts.

export type {NwcBudget, NwcBudgetSpend, NwcConnectionRecord} from './storage/nwcConnections'
export {
  clearNwcStorageForOwner,
  clearUnownedNwcStorage,
  migrateLegacyNwcStorage,
  persistNwcConnection,
  readNwcConnections,
  removeNwcConnection,
  writeNwcConnections,
} from './storage/nwcConnections'
export {readNwcEnabled, writeNwcEnabled} from './storage/nwcEnabled'
export type {NwcLegacyMigrationResult} from './storage/nwcConnections'

export {
  buildConnectionString,
  connectionInfoOf,
  createConnection,
  deriveNwcWalletKey,
  nwcWalletPubkey,
  parseConnectionString,
} from './nwc/connection'
export type {
  CreateConnectionOptions,
  CreatedConnection,
  NwcConnectionInfo,
  ParsedConnectionString,
} from './nwc/connection'

export {
  NWC_INFO_KIND,
  NWC_METHODS,
  NWC_REQUEST_KIND,
  NWC_RESPONSE_KIND,
  buildInfoEvent,
  buildResponseEvent,
  decryptRequest,
  errResult,
  okResult,
} from './nwc/protocol'
export type {
  DecryptedNwcRequest,
  NostrEvent,
  NwcEncryption,
  NwcErrorCode,
  NwcMethod,
  NwcRequest,
  NwcResponse,
} from './nwc/protocol'

export {defaultNwcTransport} from './nwc/transport'
export type {NostrFilter, NwcSubscription, NwcTransport} from './nwc/transport'

export {budgetRemainingMsat, recordSpend} from './nwc/budget'
export type {PendingInvoice, RequestContext} from './nwc/context'
export {invoiceResult, resolvePaymentHash} from './nwc/invoices'
export {payChangeset} from './nwc/pay'

export {startService} from './nwc/service'
export type {NwcChangeset, NwcService, NwcServiceDeps} from './nwc/service'
