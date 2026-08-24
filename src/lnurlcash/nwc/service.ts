// The NWC service runtime: subscribes each connection's relays for NIP-47
// requests, routes them onto the method handlers (dispatch.ts), and
// encrypts the answers back. Framework-free; sockets are only ever opened
// by the injected (or lazily-defaulted) transport inside startService.
//
// pay_invoice requests are serialized per connection through a promise
// queue, so the budget check and the spend record can't interleave;
// every other method dispatches concurrently.
//
// Foreground replay safety: requests older than MAX_REQUEST_AGE_SECONDS
// are dropped unanswered - a pay_invoice replayed after an offline
// stretch must never execute (a client that retries gets a fresh,
// answered request; a stale one answered late could double-pay). The
// foreground-only design itself is documented in the nwc.ts façade
// header.

import {linkingPubKeyHex} from '../keys'
import type {NwcConnectionRecord} from '../storage/nwcConnections'
import {readNwcConnections} from '../storage/nwcConnections'
import {assertSavedKeyOwner} from '../storage/currentOwner'

import type {NwcConnectionInfo} from './connection'
import {deriveNwcWalletKey, nwcWalletPubkey} from './connection'
import type {NwcServiceDeps, PendingInvoice, RequestContext} from './context'
import {dispatch} from './dispatch'
import type {NostrEvent, NwcEncryption, NwcRequest, NwcResponse} from './protocol'
import {NWC_REQUEST_KIND, buildInfoEvent, buildResponseEvent, decryptRequest} from './protocol'
import type {NwcSubscription} from './transport'
import {defaultNwcTransport} from './transport'

export type {NwcConnectionInfo}
export type {NwcChangeset, NwcServiceDeps} from './context'

// requests older than this are dropped unanswered (see the header)
const MAX_REQUEST_AGE_SECONDS = 600

type ConnectionRuntime = {
  info: NwcConnectionInfo
  // nulled and zeroed only after every tracked handler drains
  walletSecret: Uint8Array | null
  // invoices this connection issued, by payment hash - in-memory only:
  // pending invoices don't survive a restart (lookup then answers
  // NOT_FOUND), same as any foreground-only wallet
  invoices: Map<string, PendingInvoice>
  // serializes pay_invoice handling per connection - the budget check and
  // the spend record can't interleave
  queue: Promise<unknown>
  sub: NwcSubscription
}

export type NwcService = {
  // a snapshot of the served connections at startup; the persisted
  // records (storage/nwcConnections) carry the live budget state
  connections: NwcConnectionInfo[]
  // closes every relay subscription. In-flight handlers still finish -
  // their changesets hold money - but no new requests are picked up
  stop: () => Promise<void>
}

export const startService = async (
  linkingPrivKey: Uint8Array,
  deps: NwcServiceDeps,
  records?: NwcConnectionRecord[],
): Promise<NwcService> => {
  const transport = deps.transport ?? (await defaultNwcTransport())
  const ownerId = linkingPubKeyHex(linkingPrivKey)
  const ownedRecords = (records ?? readNwcConnections(ownerId)).filter(
    (record) => record.ownerId === ownerId,
  )
  const nowSeconds = (): number => deps.nowSeconds?.() ?? Math.floor(Date.now() / 1000)

  const publishResponse = async (
    runtime: ConnectionRuntime,
    walletSecret: Uint8Array,
    requestEventId: string,
    encryption: NwcEncryption,
    response: NwcResponse,
  ): Promise<void> => {
    await transport.publish(
      runtime.info.record.relays,
      buildResponseEvent(
        walletSecret,
        runtime.info.record.clientPubkey,
        encryption,
        requestEventId,
        response,
        nowSeconds(),
      ),
    )
  }

  // pay_invoice goes through the connection's queue (budget atomicity);
  // everything else dispatches directly
  const dispatchSerialized = (
    runtime: ConnectionRuntime,
    ctx: RequestContext,
    request: NwcRequest,
  ): Promise<NwcResponse> => {
    if (request.method !== 'pay_invoice') return dispatch(ctx, request)
    const run = runtime.queue.then(
      () => dispatch(ctx, request),
      () => dispatch(ctx, request),
    )
    runtime.queue = run.catch(() => undefined)
    return run
  }

  const handleEvent = async (
    runtime: ConnectionRuntime,
    ctx: RequestContext,
    event: NostrEvent,
  ): Promise<void> => {
    const walletSecret = runtime.walletSecret
    if (walletSecret === null) return
    const at = nowSeconds()
    // replay safety (see the header): too-old requests are dropped
    if (event.created_at < at - MAX_REQUEST_AGE_SECONDS) return
    const decrypted = decryptRequest(
      walletSecret,
      runtime.info.walletServicePubkey,
      runtime.info.record.clientPubkey,
      event,
      at,
    )
    if (decrypted === null) return
    if (decrypted.respond) {
      await publishResponse(
        runtime,
        walletSecret,
        event.id,
        decrypted.encryption,
        decrypted.response,
      )
      return
    }
    const response = await dispatchSerialized(runtime, ctx, decrypted.request)
    await publishResponse(runtime, walletSecret, event.id, decrypted.encryption, response)
  }

  let accepting = true
  // interrupts long observation waits (the invoice claim poll) at stop;
  // the drain below still awaits tasks that reached a fund-critical commit
  const stopController = new AbortController()
  const inFlight = new Set<Promise<void>>()
  const track = (task: Promise<void>): void => {
    inFlight.add(task)
    void task.then(
      () => inFlight.delete(task),
      () => inFlight.delete(task),
    )
  }
  const startBackground = (work: () => Promise<void>): boolean => {
    if (!accepting) return false
    track(work())
    return true
  }
  let runtimes = ownedRecords.map((record) => {
    const walletSecret = deriveNwcWalletKey(linkingPrivKey, record.clientPubkey)
    const runtime: ConnectionRuntime = {
      info: {record, walletServicePubkey: nwcWalletPubkey(walletSecret)},
      walletSecret,
      invoices: new Map(),
      queue: Promise.resolve(),
      // replaced below, immediately - the field exists because the
      // subscription callback closes over the runtime
      sub: {close: () => undefined},
    }
    const ctx: RequestContext = {
      deps,
      connection: () => runtime.info,
      updateRecord: (updated) => {
        runtime.info = {...runtime.info, record: updated}
      },
      invoices: runtime.invoices,
      nowSeconds,
      assertOwner: () => {
        deps.assertCurrentOwner()
        assertSavedKeyOwner(ownerId)
      },
      startBackground,
      stopSignal: stopController.signal,
    }
    runtime.sub = transport.subscribe(
      record.relays,
      {
        kinds: [NWC_REQUEST_KIND],
        '#p': [runtime.info.walletServicePubkey],
        since: nowSeconds(),
      },
      (event) => {
        if (!accepting) return
        const handler = handleEvent(runtime, ctx, event).catch((err) => {
          deps.onError?.(err, runtime.info)
        })
        track(handler)
      },
    )
    return runtime
  })

  // info events: best-effort - a rejected publish must not sink startup;
  // the client learns capabilities from its first error-free exchange too
  for (const runtime of runtimes) {
    const walletSecret = runtime.walletSecret
    if (walletSecret === null) continue
    try {
      await transport.publish(
        runtime.info.record.relays,
        buildInfoEvent(walletSecret, nowSeconds()),
      )
    } catch (error) {
      deps.onError?.(
        error instanceof Error ? error : new Error('NWC info publication failed.', {cause: error}),
        runtime.info,
      )
    }
  }

  const connections = runtimes.map((runtime) => runtime.info)
  let stopPromise: Promise<void> | null = null
  const stop = (): Promise<void> => {
    if (stopPromise !== null) return stopPromise
    accepting = false
    for (const runtime of runtimes) runtime.sub.close()
    stopController.abort()
    stopPromise = Promise.all([...inFlight])
      .then(() => undefined)
      .finally(() => {
        for (const runtime of runtimes) {
          runtime.walletSecret?.fill(0)
          runtime.walletSecret = null
          runtime.invoices.clear()
        }
        runtimes = []
      })
    return stopPromise
  }

  return {
    connections,
    stop,
  }
}
