// The NWC wallet service end to end: connection strings and key
// derivation, the request/response cycle over an in-memory relay (the
// transport is injected - no network), every method against the
// conformance mock mint, the legacy NIP-04 path, budget enforcement, and
// the error paths. Fund-safety focus: budgets can't be exceeded, stale
// requests never execute, and a settled preimage only ever reveals an
// already-rotated (burned) note secret.

import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {finalizeEvent, getPublicKey} from 'nostr-tools/pure'
import {encrypt as nip04Encrypt, decrypt as nip04Decrypt} from 'nostr-tools/nip04'
import {v2 as nip44v2} from 'nostr-tools/nip44'
import {buildNoteUrl, fetchNoteInfo, noteK1} from 'lnurlcash-kit'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'

import {
  NWC_INFO_KIND,
  NWC_REQUEST_KIND,
  NWC_RESPONSE_KIND,
  buildConnectionString,
  createConnection,
  deriveNwcWalletKey,
  parseConnectionString,
  readNwcConnections,
  startService,
  writeNwcConnections
} from './nwc'
import type {NostrEvent, NwcConnectionRecord, NwcTransport} from './nwc'
import type {NostrFilter} from './nwc/transport'
import type {NwcChangeset} from './nwc'
import type {Bearer} from './types'
import {stubLocalStorage} from './test-utils'

const LINKING_KEY = new Uint8Array(32).fill(7)
const OTHER_LINKING_KEY = new Uint8Array(32).fill(9)
const CLIENT_SECRET = hexToBytes('11'.repeat(32))
const CLIENT_PUBKEY = getPublicKey(CLIENT_SECRET)
const STRANGER_SECRET = hexToBytes('22'.repeat(32))

// never connected - the in-memory relay below stands in
const RELAYS = ['wss://relay-a.example']

let NOW = 1_800_000_000
const nowSeconds = (): number => NOW

const FAST_POLL = {intervalMs: 10, intervalCapMs: 50, maxWaitMs: 5_000}

// an in-memory relay set: subscriptions register, emit delivers to every
// matching one, publish records
const createFakeRelay = (): {
  transport: NwcTransport
  published: NostrEvent[]
  emit: (event: NostrEvent) => void
} => {
  const published: NostrEvent[] = []
  const subs: {filter: NostrFilter; onEvent: (event: NostrEvent) => void}[] = []
  const transport: NwcTransport = {
    publish: (_relays, event) => {
      published.push(event)
      return Promise.resolve()
    },
    subscribe: (_relays, filter, onEvent) => {
      const sub = {filter, onEvent}
      subs.push(sub)
      return {
        close: () => {
          const index = subs.indexOf(sub)
          if (index >= 0) subs.splice(index, 1)
        }
      }
    }
  }
  const emit = (event: NostrEvent): void => {
    for (const sub of [...subs]) {
      const kindsMatch =
        !sub.filter.kinds || sub.filter.kinds.includes(event.kind)
      const wanted = sub.filter['#p']
      const pMatch =
        !wanted ||
        event.tags.some(t => t[0] === 'p' && wanted.includes(t[1] ?? ''))
      const sinceMatch =
        sub.filter.since === undefined || event.created_at >= sub.filter.since
      if (kindsMatch && pMatch && sinceMatch) sub.onEvent(event)
    }
  }
  return {transport, published, emit}
}

type Encryption = 'nip44_v2' | 'nip04' | 'none'

// a NIP-47 request exactly as a real client would build it, signed by the
// connection's client secret
const clientRequest = (
  walletServicePubkey: string,
  content: string,
  scheme: Encryption = 'nip44_v2',
  createdAt: number = NOW
): NostrEvent => {
  const tags: string[][] = [['p', walletServicePubkey]]
  if (scheme !== 'none') tags.push(['encryption', scheme])
  return finalizeEvent(
    {
      kind: NWC_REQUEST_KIND,
      created_at: createdAt,
      tags,
      content:
        scheme === 'nip44_v2'
          ? nip44v2.encrypt(
              content,
              nip44v2.utils.getConversationKey(CLIENT_SECRET, walletServicePubkey)
            )
          : nip04Encrypt(CLIENT_SECRET, walletServicePubkey, content)
    },
    CLIENT_SECRET
  )
}

const methodRequest = (
  walletServicePubkey: string,
  method: string,
  params: Record<string, unknown>,
  scheme: Encryption = 'nip44_v2',
  createdAt?: number
): NostrEvent =>
  clientRequest(
    walletServicePubkey,
    JSON.stringify({method, params}),
    scheme,
    createdAt
  )

// generous: a failed/never-settling melt is only classified after the
// verify-poll budget (seconds) runs out
const waitFor = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 3000 && !cond(); i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  expect(cond()).toBe(true)
}

type NwcResponsePayload = {
  result_type: string
  error: {code: string; message: string} | null
  result: Record<string, unknown> | null
}

const readResponse = (
  published: NostrEvent[],
  requestId: string,
  scheme: Encryption
): NwcResponsePayload | null => {
  const event = published.find(
    e =>
      e.kind === NWC_RESPONSE_KIND &&
      e.tags.some(t => t[0] === 'e' && t[1] === requestId)
  )
  if (!event) return null
  const plaintext =
    scheme === 'nip44_v2'
      ? nip44v2.decrypt(
          event.content,
          nip44v2.utils.getConversationKey(CLIENT_SECRET, event.pubkey)
        )
      : nip04Decrypt(CLIENT_SECRET, event.pubkey, event.content)
  return JSON.parse(plaintext) as NwcResponsePayload
}

// drives one full request/response round trip over the fake relay
const call = async (
  relay: ReturnType<typeof createFakeRelay>,
  walletServicePubkey: string,
  method: string,
  params: Record<string, unknown>,
  scheme: Encryption = 'nip44_v2'
): Promise<NwcResponsePayload> => {
  const request = methodRequest(walletServicePubkey, method, params, scheme)
  relay.emit(request)
  await waitFor(() => readResponse(relay.published, request.id, scheme) !== null)
  return readResponse(relay.published, request.id, scheme)!
}

type Mint = Awaited<ReturnType<typeof createMockMint>>
const mints: Mint[] = []
const mint = async (
  options: Parameters<typeof createMockMint>[0] = {}
): Promise<Mint> => {
  const m = await createMockMint(options)
  mints.push(m)
  return m
}

afterEach(async () => {
  await Promise.all(mints.splice(0).map(m => m.close()))
})

let bearerCounter = 0
const makeBearer = async (m: Mint, k1: string, amountMsat: number): Promise<Bearer> => {
  m.state.creditNote(k1, amountMsat)
  const url = buildNoteUrl(`${m.url}/w`, k1, amountMsat)
  const info = await fetchNoteInfo(url)
  bearerCounter += 1
  return {
    id: `bearer-${bearerCounter}`,
    url,
    callback: info.callback,
    amount: info.maxWithdrawable,
    verified: true,
    mintPubkey: m.state.pubkey,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

// the harness around startService: a fake relay, an in-memory "store"
// applying changesets the way the Pinia layer will, and a created
// connection with a pinned client secret
const startTestService = async (options: {
  budgetMsat?: number
  periodMs?: number
  defaultMint?: string | null
  linkingKey?: Uint8Array
  poll?: typeof FAST_POLL
}): Promise<{
  relay: ReturnType<typeof createFakeRelay>
  walletServicePubkey: string
  state: {bearers: Bearer[]; changesets: NwcChangeset[]; errors: unknown[]}
  stop: () => void
}> => {
  const budgetMsat = options.budgetMsat ?? 1_000_000_000
  const connection = createConnection(options.linkingKey ?? LINKING_KEY, {
    relays: RELAYS,
    budget: {maxMsat: budgetMsat, periodMs: options.periodMs ?? 86_400_000},
    clientSecret: CLIENT_SECRET,
    now: NOW * 1000
  })
  const relay = createFakeRelay()
  const state = {
    bearers: [] as Bearer[],
    changesets: [] as NwcChangeset[],
    errors: [] as unknown[]
  }
  const service = await startService(options.linkingKey ?? LINKING_KEY, {
    getBearers: () => state.bearers,
    getDefaultMint: () => options.defaultMint ?? null,
    applyChangeset: (changeset: NwcChangeset) => {
      state.changesets.push(changeset)
      for (const id of changeset.markSpent) {
        const bearer = state.bearers.find(b => b.id === id)
        if (bearer) bearer.spent = true
      }
      for (const note of changeset.add) {
        bearerCounter += 1
        state.bearers.push({
          ...note,
          id: `added-${bearerCounter}`,
          createdAt: Date.now(),
          updatedAt: Date.now()
        })
      }
    },
    onError: err => {
      state.errors.push(err)
    },
    transport: relay.transport,
    poll: options.poll ?? FAST_POLL,
    claimPoll: FAST_POLL,
    nowSeconds
  })
  return {
    relay,
    walletServicePubkey: connection.walletServicePubkey,
    state,
    stop: service.stop
  }
}

beforeEach(() => {
  stubLocalStorage()
  NOW = 1_800_000_000
})

describe('connection strings', () => {
  it('round-trips build -> parse, including several relays', () => {
    const uri = buildConnectionString(
      'ab'.repeat(32),
      'cd'.repeat(32),
      ['wss://relay-a.example', 'wss://relay-b.example/path?q=1']
    )
    expect(uri).toBe(
      `nostr+walletconnect://${'ab'.repeat(32)}?relay=${encodeURIComponent('wss://relay-a.example')}&relay=${encodeURIComponent('wss://relay-b.example/path?q=1')}&secret=${'cd'.repeat(32)}`
    )
    expect(parseConnectionString(uri)).toEqual({
      walletServicePubkey: 'ab'.repeat(32),
      clientSecret: 'cd'.repeat(32),
      relays: ['wss://relay-a.example', 'wss://relay-b.example/path?q=1']
    })
  })

  it('rejects strings that are not connection strings', () => {
    expect(parseConnectionString('not a uri')).toBeNull()
    expect(parseConnectionString('https://example.com')).toBeNull()
    // missing secret
    expect(
      parseConnectionString(
        `nostr+walletconnect://${'ab'.repeat(32)}?relay=wss%3A%2F%2Fr.example`
      )
    ).toBeNull()
    // missing relay
    expect(
      parseConnectionString(
        `nostr+walletconnect://${'ab'.repeat(32)}?secret=${'cd'.repeat(32)}`
      )
    ).toBeNull()
    // a non-hex pubkey
    expect(
      parseConnectionString(
        'nostr+walletconnect://zzzz?relay=wss%3A%2F%2Fr.example&secret=' + 'cd'.repeat(32)
      )
    ).toBeNull()
  })

  it('createConnection returns a string that parses back to the same connection', () => {
    const connection = createConnection(LINKING_KEY, {
      relays: RELAYS,
      budget: {maxMsat: 100_000, periodMs: 86_400_000},
      clientSecret: CLIENT_SECRET
    })
    const parsed = parseConnectionString(connection.connectionString)
    expect(parsed).toEqual({
      walletServicePubkey: connection.walletServicePubkey,
      clientSecret: '11'.repeat(32),
      relays: RELAYS
    })
    // the record persisted WITHOUT the client secret - it is handed out
    // once, in the connection string, and never stored
    const records = readNwcConnections()
    expect(records).toHaveLength(1)
    expect(records[0]!.clientPubkey).toBe(CLIENT_PUBKEY)
    expect(JSON.stringify(records[0])).not.toContain('11'.repeat(32))
  })
})

describe('deriveNwcWalletKey', () => {
  it('is pinned: derivation changes would silently orphan every connection', () => {
    expect(bytesToHex(deriveNwcWalletKey(LINKING_KEY, CLIENT_PUBKEY))).toBe(
      '71428fc3d77c75f9dc70037283fbed5407cecc44eab56873986a33c24c3e034d'
    )
    expect(
      getPublicKey(deriveNwcWalletKey(LINKING_KEY, CLIENT_PUBKEY))
    ).toBe('bf02224dc973a24466ded285c24fb5baf78352b0a2364de7a15b0263fc048bcf')
  })

  it('derives a distinct key per client and per linking key', () => {
    const base = bytesToHex(deriveNwcWalletKey(LINKING_KEY, CLIENT_PUBKEY))
    expect(
      bytesToHex(deriveNwcWalletKey(LINKING_KEY, getPublicKey(STRANGER_SECRET)))
    ).not.toBe(base)
    expect(
      bytesToHex(deriveNwcWalletKey(OTHER_LINKING_KEY, CLIENT_PUBKEY))
    ).not.toBe(base)
  })

  it('re-derives the same wallet identity from a persisted record after a reinstall', () => {
    const first = createConnection(LINKING_KEY, {
      relays: RELAYS,
      budget: {maxMsat: 100_000, periodMs: 86_400_000},
      clientSecret: CLIENT_SECRET
    })
    expect(first.walletServicePubkey).toBe(
      'bf02224dc973a24466ded285c24fb5baf78352b0a2364de7a15b0263fc048bcf'
    )
  })
})

describe('storage validation', () => {
  it('drops malformed records instead of throwing', () => {
    localStorage.setItem(
      'sattle_nwc_connections',
      JSON.stringify([
        {clientPubkey: 'nope'},
        {
          clientPubkey: CLIENT_PUBKEY,
          relays: RELAYS,
          budget: {maxMsat: 1000, periodMs: 1000},
          spent: {periodStart: 0, msat: 0},
          createdAt: 0
        }
      ])
    )
    expect(readNwcConnections()).toHaveLength(1)
    expect(readNwcConnections()[0]!.clientPubkey).toBe(CLIENT_PUBKEY)
  })

  it('returns nothing for garbage json', () => {
    localStorage.setItem('sattle_nwc_connections', '{{{')
    expect(readNwcConnections()).toEqual([])
  })
})

describe('service: info and balance', () => {
  it('publishes a kind-13194 info event on startup', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const info = relay.published.find(e => e.kind === NWC_INFO_KIND)
    expect(info).toBeDefined()
    expect(info!.pubkey).toBe(walletServicePubkey)
    expect(info!.content).toContain('pay_invoice')
    expect(info!.content).toContain('make_invoice')
    expect(info!.tags).toContainEqual(['encryption', 'nip44_v2 nip04'])
    stop()
  })

  it('answers get_info with the connection identity and method list', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const response = await call(relay, walletServicePubkey, 'get_info', {})
    expect(response.error).toBeNull()
    expect(response.result_type).toBe('get_info')
    expect(response.result).toMatchObject({
      alias: 'sattle',
      pubkey: walletServicePubkey,
      methods: [
        'get_info',
        'get_balance',
        'make_invoice',
        'pay_invoice',
        'lookup_invoice'
      ]
    })
    stop()
  })

  it('answers get_balance with the spendable total only', async () => {
    const m = await mint()
    const {relay, walletServicePubkey, state, stop} = await startTestService({})
    state.bearers = [
      await makeBearer(m, 'aa'.repeat(32), 21_000),
      await makeBearer(m, 'bb'.repeat(32), 5_000),
      {...(await makeBearer(m, 'cc'.repeat(32), 99_000)), spent: true}
    ]
    const response = await call(relay, walletServicePubkey, 'get_balance', {})
    expect(response.error).toBeNull()
    expect(response.result).toEqual({balance: 26_000})
    stop()
  })
})

describe('service: request validation', () => {
  it('answers an unknown method with NOT_IMPLEMENTED', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const response = await call(relay, walletServicePubkey, 'get_payments', {})
    expect(response.result_type).toBe('get_payments')
    expect(response.error?.code).toBe('NOT_IMPLEMENTED')
    expect(response.result).toBeNull()
    stop()
  })

  it('answers a malformed (non-JSON) request with an error, not a crash', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const request = clientRequest(walletServicePubkey, 'this is not json')
    relay.emit(request)
    await waitFor(
      () => readResponse(relay.published, request.id, 'nip44_v2') !== null
    )
    const response = readResponse(relay.published, request.id, 'nip44_v2')!
    expect(response.error?.code).toBe('OTHER')
    stop()
  })

  it('answers a JSON request without a method with an error', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const request = clientRequest(walletServicePubkey, JSON.stringify({params: {}}))
    relay.emit(request)
    await waitFor(
      () => readResponse(relay.published, request.id, 'nip44_v2') !== null
    )
    expect(readResponse(relay.published, request.id, 'nip44_v2')!.error?.code).toBe(
      'OTHER'
    )
    stop()
  })

  it('ignores a request signed by a stranger key - silently', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const content = nip44v2.encrypt(
      JSON.stringify({method: 'get_balance', params: {}}),
      nip44v2.utils.getConversationKey(STRANGER_SECRET, walletServicePubkey)
    )
    const forged = finalizeEvent(
      {
        kind: NWC_REQUEST_KIND,
        created_at: NOW,
        tags: [['p', walletServicePubkey], ['encryption', 'nip44_v2']],
        content
      },
      STRANGER_SECRET
    )
    relay.emit(forged)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(
      relay.published.filter(e => e.kind === NWC_RESPONSE_KIND)
    ).toHaveLength(0)
    stop()
  })

  it('answers an unsupported encryption scheme with UNSUPPORTED_ENCRYPTION', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const content = nip04Encrypt(
      CLIENT_SECRET,
      walletServicePubkey,
      JSON.stringify({method: 'get_balance', params: {}})
    )
    const request = finalizeEvent(
      {
        kind: NWC_REQUEST_KIND,
        created_at: NOW,
        tags: [['p', walletServicePubkey], ['encryption', 'nip17']],
        content
      },
      CLIENT_SECRET
    )
    relay.emit(request)
    // the error answer goes out in the legacy scheme every client reads
    await waitFor(
      () => readResponse(relay.published, request.id, 'nip04') !== null
    )
    expect(
      readResponse(relay.published, request.id, 'nip04')!.error?.code
    ).toBe('UNSUPPORTED_ENCRYPTION')
    stop()
  })

  it('speaks legacy NIP-04: no encryption tag, and an explicit nip04 tag', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    for (const scheme of ['none', 'nip04'] as const) {
      const request = methodRequest(walletServicePubkey, 'get_balance', {}, scheme)
      relay.emit(request)
      await waitFor(
        () => readResponse(relay.published, request.id, 'nip04') !== null
      )
      const response = readResponse(relay.published, request.id, 'nip04')!
      expect(response.error).toBeNull()
      expect(response.result).toEqual({balance: 0})
      // the response mirrors the request's scheme
      const event = relay.published.find(
        e =>
          e.kind === NWC_RESPONSE_KIND &&
          e.tags.some(t => t[0] === 'e' && t[1] === request.id)
      )!
      expect(event.tags).toContainEqual(['encryption', 'nip04'])
    }
    stop()
  })

  it('drops requests older than the replay window unanswered', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const stale = methodRequest(
      walletServicePubkey,
      'get_balance',
      {},
      'nip44_v2',
      NOW - 1200
    )
    relay.emit(stale)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(
      relay.published.filter(e => e.kind === NWC_RESPONSE_KIND)
    ).toHaveLength(0)
    stop()
  })

  it('picks up no new requests after stop', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    stop()
    const request = methodRequest(walletServicePubkey, 'get_balance', {})
    relay.emit(request)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(
      relay.published.filter(e => e.kind === NWC_RESPONSE_KIND)
    ).toHaveLength(0)
  })
})

describe('service: pay_invoice', () => {
  it('pays a bolt11 by melting, returning the melt preimage and recording the spend', async () => {
    const m = await mint()
    const {relay, walletServicePubkey, state, stop} = await startTestService({
      budgetMsat: 50_000
    })
    state.bearers = [await makeBearer(m, 'dd'.repeat(32), 21_000)]

    const response = await call(relay, walletServicePubkey, 'pay_invoice', {
      invoice: 'lnbc210n1pjqrstuvwxyz'
    })
    expect(response.error).toBeNull()
    expect(typeof response.result?.preimage).toBe('string')
    expect((response.result?.preimage as string).length).toBe(64)

    // the note is gone (melted) and locked spent via the changeset
    expect(m.state.noteState('dd'.repeat(32))).toBe('burned')
    expect(state.bearers[0]!.spent).toBe(true)

    // the spend was recorded against the budget, persisted
    expect(readNwcConnections()[0]!.spent.msat).toBe(21_000)
    stop()
  })

  it('rejects a payment over the connection budget with QUOTA_EXCEEDED', async () => {
    const m = await mint()
    const {relay, walletServicePubkey, state, stop} = await startTestService({
      budgetMsat: 20_000
    })
    state.bearers = [await makeBearer(m, 'ee'.repeat(32), 21_000)]

    const response = await call(relay, walletServicePubkey, 'pay_invoice', {
      invoice: 'lnbc210n1pjqrstuvwxyz'
    })
    expect(response.error?.code).toBe('QUOTA_EXCEEDED')
    // nothing moved: the note is untouched, no spend recorded
    expect(m.state.noteState('ee'.repeat(32))).toBe('outstanding')
    expect(state.bearers[0]!.spent).toBeUndefined()
    expect(readNwcConnections()[0]!.spent.msat).toBe(0)
    stop()
  })

  it('resets the allowance once the budget period has rolled over', async () => {
    const m = await mint()
    const {relay, walletServicePubkey, state, stop} = await startTestService({
      budgetMsat: 21_000,
      periodMs: 60_000
    })
    // simulate a fully spent budget from a period that ended long ago
    const record: NwcConnectionRecord = readNwcConnections()[0]!
    writeNwcConnections([
      {...record, spent: {periodStart: Date.now() - 120_000, msat: 21_000}}
    ])
    state.bearers = [await makeBearer(m, 'ef'.repeat(32), 21_000)]

    const response = await call(relay, walletServicePubkey, 'pay_invoice', {
      invoice: 'lnbc210n1pjqrstuvwxyz'
    })
    expect(response.error).toBeNull()
    expect(readNwcConnections()[0]!.spent.msat).toBe(21_000)
    stop()
  })

  it('rejects a payment the wallet cannot cover with INSUFFICIENT_BALANCE', async () => {
    const m = await mint()
    const {relay, walletServicePubkey, state, stop} = await startTestService({})
    state.bearers = [await makeBearer(m, 'ff'.repeat(32), 5_000)]

    const response = await call(relay, walletServicePubkey, 'pay_invoice', {
      invoice: 'lnbc210n1pjqrstuvwxyz'
    })
    expect(response.error?.code).toBe('INSUFFICIENT_BALANCE')
    expect(m.state.noteState('ff'.repeat(32))).toBe('outstanding')
    stop()
  })

  it('rejects a request amount that mismatches the invoice amount', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const response = await call(relay, walletServicePubkey, 'pay_invoice', {
      invoice: 'lnbc210n1pjqrstuvwxyz',
      amount: 5_000
    })
    expect(response.error?.code).toBe('OTHER')
    expect(response.error?.message).toMatch(/match/i)
    stop()
  })

  it('rejects an amount-less invoice instead of guessing', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const response = await call(relay, walletServicePubkey, 'pay_invoice', {
      invoice: 'lnbc1pjqrstuvwxyz'
    })
    expect(response.error?.code).toBe('OTHER')
    expect(response.error?.message).toMatch(/amount/i)
    stop()
  })

  it('answers a failed melt with PAYMENT_FAILED and tracks the returned funds', async () => {
    const m = await mint({meltAlwaysFails: true})
    const {relay, walletServicePubkey, state, stop} = await startTestService({
      // a short verify budget: the failed melt is classified by the poll
      // running out, and that wait is the test's own clock
      poll: {intervalMs: 10, intervalCapMs: 20, maxWaitMs: 300}
    })
    state.bearers = [await makeBearer(m, '01'.repeat(32), 21_000)]

    const response = await call(relay, walletServicePubkey, 'pay_invoice', {
      invoice: 'lnbc210n1pjqrstuvwxyz'
    })
    expect(response.error?.code).toBe('PAYMENT_FAILED')

    // the funds came back, re-secured: the old secret burned, a fresh one
    // tracked unspent via the changeset - and no budget spend recorded
    expect(m.state.noteState('01'.repeat(32))).toBe('burned')
    const returned = state.bearers.find(b => b.id.startsWith('added-'))
    expect(returned).toBeDefined()
    expect(returned!.spent).toBeUndefined()
    expect(returned!.amount).toBe(21_000)
    expect(m.state.noteState(noteK1(returned!.url)!)).toBe('outstanding')
    expect(readNwcConnections()[0]!.spent.msat).toBe(0)
    stop()
  })
})

describe('service: make_invoice / lookup_invoice', () => {
  it('issues an invoice, settles it in the background, and reports the preimage', async () => {
    const m = await mint({testHooks: true})
    const {relay, walletServicePubkey, state, stop} = await startTestService({
      defaultMint: `mint@127.0.0.1:${m.port}`
    })

    const made = await call(relay, walletServicePubkey, 'make_invoice', {
      amount: 21_000,
      description: 'nwc test',
      expiry: 3600
    })
    expect(made.error).toBeNull()
    expect(made.result).toMatchObject({
      type: 'incoming',
      state: 'pending',
      amount: 21_000,
      description: 'nwc test',
      created_at: NOW,
      expires_at: NOW + 3600
    })
    const invoice = made.result!.invoice as string
    const paymentHash = made.result!.payment_hash as string
    expect(invoice).toMatch(/^lnbc/)
    expect(paymentHash).toMatch(/^[0-9a-f]{64}$/)

    // before settlement the lookup reports the pending invoice
    const pending = await call(relay, walletServicePubkey, 'lookup_invoice', {
      payment_hash: paymentHash
    })
    expect(pending.error).toBeNull()
    expect(pending.result?.state).toBe('pending')
    expect(pending.result?.preimage).toBeUndefined()

    // the "payer" pays the invoice; the background claim settles and
    // mints the note
    const settleRes = await fetch(
      `${m.url}/_test/settle?payment_hash=${paymentHash}`
    )
    expect(settleRes.ok).toBe(true)
    await waitFor(() =>
      state.changesets.some(c => c.add.length > 0)
    )

    const settled = await call(relay, walletServicePubkey, 'lookup_invoice', {
      payment_hash: paymentHash
    })
    expect(settled.error).toBeNull()
    expect(settled.result?.state).toBe('settled')
    expect(settled.result?.settled_at).toBe(NOW)
    const preimage = settled.result?.preimage as string
    expect(preimage).toMatch(/^[0-9a-f]{64}$/)

    // the minted note was claimed AND rotated before settlement was
    // recorded: the preimage the client just learned is a burned secret,
    // and the wallet's fresh note is the only live one
    expect(m.state.noteState(preimage)).toBe('burned')
    const minted = state.bearers.find(b => b.id.startsWith('added-'))!
    expect(minted.amount).toBe(21_000)
    expect(minted.verified).toBe(true)
    expect(noteK1(minted.url)).not.toBe(preimage)
    expect(m.state.noteState(noteK1(minted.url)!)).toBe('outstanding')
    stop()
  })

  it('finds an invoice by its invoice string too', async () => {
    const m = await mint({testHooks: true})
    const {relay, walletServicePubkey, stop} = await startTestService({
      defaultMint: `mint@127.0.0.1:${m.port}`
    })
    const made = await call(relay, walletServicePubkey, 'make_invoice', {
      amount: 5_000
    })
    const found = await call(relay, walletServicePubkey, 'lookup_invoice', {
      invoice: (made.result!.invoice as string).toUpperCase()
    })
    expect(found.error).toBeNull()
    expect(found.result?.payment_hash).toBe(made.result!.payment_hash)
    stop()
  })

  it('answers an unknown invoice with NOT_FOUND', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const response = await call(relay, walletServicePubkey, 'lookup_invoice', {
      payment_hash: 'ab'.repeat(32)
    })
    expect(response.error?.code).toBe('NOT_FOUND')
    stop()
  })

  it('answers make_invoice without a default mint with INTERNAL', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({
      defaultMint: null
    })
    const response = await call(relay, walletServicePubkey, 'make_invoice', {
      amount: 21_000
    })
    expect(response.error?.code).toBe('INTERNAL')
    stop()
  })

  it('answers a make_invoice with a bad amount with OTHER', async () => {
    const {relay, walletServicePubkey, stop} = await startTestService({})
    const response = await call(relay, walletServicePubkey, 'make_invoice', {
      amount: -5
    })
    expect(response.error?.code).toBe('OTHER')
    stop()
  })
})
