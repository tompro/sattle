// Wire-contract coverage for the pinned lnurlcash-kit 0.8.0 /
// lnurlcash-conformance 0.7.0 artifacts. Contracts the app's mint flows
// rely on:
// the kit must MAP the mint-address wire field `nodeCapacity` onto the
// app-facing `nodeCapacityMsat` (0.1.0 spread it under its wire name, so
// the typed field read undefined forever); a payRequest withdraw link is
// legal in both its HTTPS and LUD-17 `lnurlw://` forms (the conformance
// mock emits either, selected by its withdrawLinkForm option, so do NOT
// assume a default anywhere in the receive path); and the LUD-06 quote
// request must carry the output-naming hash (as BOTH `comment` and `h`)
// exactly when - and only when - the payRequest advertised the capability
// (commentAllowed >= 64 or mintToHash): a new-generation mint
// (lnurl-mint >= 0.4) refuses a quote without it, while an old mint must
// see the byte-identical request this wallet always sent.

import {afterEach, describe, expect, it} from 'vitest'
import {createMockMint} from 'lnurlcash-conformance/mock-mint'
import {buildNoteUrl, fetchMintAddress, hashK1} from 'lnurlcash-kit'

import {claimMintedNote, prepareMint} from './ops'
import {mintAddressCacheInfo} from './trustedMints'
import './mintContract.v08.cases'

type Mint = Awaited<ReturnType<typeof createMockMint>>

const mints: Mint[] = []
const mint = async (options: Parameters<typeof createMockMint>[0] = {}): Promise<Mint> => {
  const m = await createMockMint(options)
  mints.push(m)
  return m
}

afterEach(async () => {
  await Promise.all(mints.splice(0).map((m) => m.close()))
})

// paying a mint invoice is what brings its note into existence - the mock
// exposes that through its test hook (settle + credit in one step)
const settleLastInvoice = async (m: Mint): Promise<string> => {
  const paymentHash = [...m.state.invoices.keys()].at(-1)
  if (!paymentHash) throw new Error('no invoice requested yet')
  const res = await fetch(`${m.url}/_test/settle?payment_hash=${paymentHash}`)
  if (!res.ok) throw new Error(`settle hook failed: ${res.status}`)
  const invoice = m.state.invoices.get(paymentHash)
  if (!invoice) throw new Error('settled invoice vanished from the mock')
  return invoice.preimage
}

const MINT_PUBKEY = `02${'ab'.repeat(32)}`

// a mint-address (LUD-25) wire response exactly as lnurl-mint serves it:
// node stats under their WIRE names - `nodeCapacity` is msat like every
// other amount, named without the suffix on the wire
const mintAddressFixture = {
  tag: 'withdrawRequest',
  callback: 'https://mint.example/w/cb',
  minWithdrawable: 1_000,
  maxWithdrawable: 100_000_000,
  defaultDescription: 'fixture mint',
  payLink: 'https://mint.example/.well-known/lnurlp/mint',
  mintPubkey: MINT_PUBKEY,
  nodeAlias: 'fixture-mint',
  nodeCapacity: 500_000_000,
  nodeNumChannels: 4,
  nodeNumPeers: 6,
}

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {'content-type': 'application/json'},
  })

// a fetch that serves fixture bodies by URL prefix and 404s everything else,
// so a test drives the real kit HTTP boundary without any network
const fixtureFetch = (routes: ReadonlyArray<readonly [string, unknown]>): typeof fetch => {
  const impl: typeof fetch = (input, _init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    for (const [prefix, body] of routes) {
      if (url.startsWith(prefix)) return Promise.resolve(jsonResponse(body))
    }
    return Promise.resolve(new Response('not found', {status: 404}))
  }
  return impl
}

// fixtureFetch plus a record of every URL it saw, for canaries about the
// exact query the kit puts on the wire
const capturingFetch = (
  routes: ReadonlyArray<readonly [string, unknown]>,
  seen: string[],
): typeof fetch => {
  const impl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    seen.push(url)
    return fixtureFetch(routes)(input, init)
  }
  return impl
}

describe('mint-address wire contract', () => {
  it('maps the wire nodeCapacity onto the app-facing nodeCapacityMsat', async () => {
    const info = await fetchMintAddress('https://mint.example/.well-known/lnurlw/mint', {
      fetch: fixtureFetch([['https://mint.example/', mintAddressFixture]]),
    })
    // renamed fields have to be mapped, not spread: the spread carries the
    // wire name through and the typed one reads undefined forever
    expect(info.nodePubkey).toBe(MINT_PUBKEY)
    expect(info.nodeCapacityMsat).toBe(500_000_000)
    expect(info.nodeNumChannels).toBe(4)
    expect(info.nodeNumPeers).toBe(6)
  })

  it('carries node stats into the cached trusted-mint display metadata', async () => {
    const info = await fetchMintAddress('https://mint.example/.well-known/lnurlw/mint', {
      fetch: fixtureFetch([['https://mint.example/', mintAddressFixture]]),
    })
    const cached = mintAddressCacheInfo(info, 'mint')
    expect(cached?.nodeCapacityMsat).toBe(500_000_000)
    expect(cached?.nodeNumChannels).toBe(4)
    expect(cached?.nodeNumPeers).toBe(6)
  })

  it("surfaces the mock mint's mint-address node stats through prepareMint", async () => {
    const m = await mint()
    const prepared = await prepareMint(`mint@127.0.0.1:${m.port}`, 21_000)
    // the metadata is advertised at the mint-address endpoint itself -
    // the payRequest never carried it
    expect(prepared.nodeInfo?.nodePubkey).toBe(m.state.pubkey)
    expect(prepared.nodeInfo?.nodeCapacityMsat).toBe(500_000_000)
    expect(prepared.nodeInfo?.nodeNumChannels).toBe(4)
    expect(prepared.nodeInfo?.nodeNumPeers).toBe(6)
    const cached = mintAddressCacheInfo(prepared.nodeInfo, prepared.username)
    expect(cached?.nodeCapacityMsat).toBe(500_000_000)
  })
})

describe('withdraw-link forms', () => {
  it('accepts the lnurlw:// withdraw link the conformance mock mint advertises', async () => {
    // conformance 0.7.0 defaults to plain https links; lnurlw:// is an
    // explicit LUD-17 transport form
    const m = await mint({testHooks: true, withdrawLinkForm: 'lnurlw'})
    const prepared = await prepareMint(`mint@127.0.0.1:${m.port}`, 21_000)
    expect(prepared.withdrawLink).toMatch(/^lnurlw:\/\//)

    // and the link is fully usable: settle the invoice, claim the note
    const preimage = await settleLastInvoice(m)
    const claimed = await claimMintedNote(prepared, {
      intervalMs: 10,
      intervalCapMs: 50,
      maxWaitMs: 5_000,
    })
    expect(claimed.rotated).toBe(true)
    expect(claimed.note.amount).toBe(21_000)
    expect(m.state.noteState(preimage)).toBe('burned')
  })

  it('accepts an HTTPS withdraw link', async () => {
    const fetch = fixtureFetch([
      ['https://mint.example/.well-known/lnurlw/mint', mintAddressFixture],
      [
        'https://mint.example/.well-known/lnurlp/mint',
        {
          tag: 'payRequest',
          callback: 'https://mint.example/pay',
          minSendable: 1_000,
          maxSendable: 100_000_000_000,
          withdrawLink: 'https://mint.example/note',
          metadata: '[]',
        },
      ],
      // amount-less invoice: the kit skips its amount cross-check
      ['https://mint.example/pay', {pr: 'lnmock1fixture', verify: null}],
    ])
    const prepared = await prepareMint('mint@mint.example', 21_000, {fetch})
    expect(prepared.withdrawLink).toBe('https://mint.example/note')
    // the mint-address payLink is authoritative - the payRequest came from it
    expect(prepared.mintUrl).toBe('https://mint.example/.well-known/lnurlp/mint')
  })

  it('builds the same note URL from both withdraw-link forms', () => {
    const k1 = 'ab'.repeat(32)
    expect(buildNoteUrl('lnurlw://mint.example/note', k1, 21_000)).toBe(
      buildNoteUrl('https://mint.example/note', k1, 21_000),
    )
  })
})

describe('quote output-naming wire contract', () => {
  const payRequestFixture = (extra: Record<string, unknown>) => ({
    tag: 'payRequest',
    callback: 'https://mint.example/pay',
    minSendable: 1_000,
    maxSendable: 100_000_000_000,
    withdrawLink: 'https://mint.example/note',
    metadata: '[]',
    ...extra,
  })
  const routesFor = (payRequest: Record<string, unknown>) =>
    [
      ['https://mint.example/.well-known/lnurlw/mint', mintAddressFixture],
      ['https://mint.example/.well-known/lnurlp/mint', payRequest],
      // amount-less invoice: the kit skips its amount cross-check
      ['https://mint.example/pay', {pr: 'lnmock1fixture', verify: null}],
    ] as const

  const callbackUrl = (seen: string[]): URL => {
    const hit = seen.find((url) => url.startsWith('https://mint.example/pay?'))
    if (!hit) throw new Error('the quote request never hit the wire')
    return new URL(hit)
  }

  it('sends no comment/h to a mint that never advertised output naming', async () => {
    const seen: string[] = []
    const prepared = await prepareMint('mint@mint.example', 21_000, {
      fetch: capturingFetch(routesFor(payRequestFixture({})), seen),
    })
    expect(prepared.mode).toBe('unnamed')
    expect(prepared.noteSecret).toBeUndefined()
    // an old mint sees the byte-identical request this wallet always sent
    const url = callbackUrl(seen)
    expect(url.searchParams.get('comment')).toBeNull()
    expect(url.searchParams.get('h')).toBeNull()
  })

  it('sends comment AND h, both sha256 of the wallet secret, when commentAllowed >= 64', async () => {
    const seen: string[] = []
    const prepared = await prepareMint('mint@mint.example', 21_000, {
      fetch: capturingFetch(routesFor(payRequestFixture({commentAllowed: 64})), seen),
    })
    expect(prepared.mode).toBe('named')
    const noteSecret = prepared.noteSecret
    if (!noteSecret) throw new Error('named mode without a note secret')
    const url = callbackUrl(seen)
    // both spellings go out together: `comment` is the LUD-25 form
    // lnurl-mint >= 0.4 REQUIRES, `h` the earlier form other mints read
    const comment = url.searchParams.get('comment')
    const h = url.searchParams.get('h')
    expect(comment).toMatch(/^[0-9a-f]{64}$/)
    expect(h).toBe(comment)
    expect(comment).toBe(hashK1(noteSecret))
  })

  it('names the output when only the mintToHash spelling is advertised', async () => {
    const seen: string[] = []
    const prepared = await prepareMint('mint@mint.example', 21_000, {
      fetch: capturingFetch(routesFor(payRequestFixture({mintToHash: true})), seen),
    })
    expect(prepared.mode).toBe('named')
    const noteSecret = prepared.noteSecret
    if (!noteSecret) throw new Error('named mode without a note secret')
    expect(callbackUrl(seen).searchParams.get('h')).toBe(hashK1(noteSecret))
  })
})
