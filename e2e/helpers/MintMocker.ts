import type { Page, Route } from '@playwright/test';
import { hashK1, noteSignatureDigestForHash } from 'lnurlcash-kit';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

// The mock mint lives on a .test origin that never resolves - every request
// to it is intercepted by Playwright and fulfilled in-process, so the specs
// never touch the network. Protocol shapes mirror lnurlcash-kit's client:
// the informational GET on the note URL (fetchNoteInfo) expects an LUD-03
// withdrawRequest echoing the queried k1, or the LNURL ERROR envelope; the
// mutating GET on the callback (rotate/split/merge/melt) expects
// {status: "OK"} plus the LUD-25 signature(s) over every minted output -
// the app forces the kit's requireSignatures policy, so an unsigned
// mutation answer is not a success the wallet accepts quietly.
//
// Signing: each origin has a stable secp256k1 signing key derived from its
// origin string, so a spec can pin the advertised mintPubkey via
// signingPubkey(origin). `invalidSignatures = true` signs every output with
// a foreign key instead - the notes are real mint-side, but the offline
// proof verifies against no key the mint advertises, which is exactly the
// "landed but unverifiable" case the wallet must refuse to mark spendable.
//
// Every method takes an optional origin, so a spec can stand up a SECOND
// mint (e.g. MINT2_ORIGIN) for inter-mint transfers.
export const MINT_ORIGIN = 'https://mint.test';
export const MINT2_ORIGIN = 'https://mint2.test';
export const NOTE_PATH = '/note';
export const CALLBACK_PATH = '/callback';

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const fulfillJson = async (route: Route, body: unknown): Promise<void> => {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    // the app runs on http://localhost:9333, so the mint is cross-origin -
    // keep Chromium's CORS check on the fulfilled response happy
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body),
  });
};

// deterministic per-origin signing keys: the mock mints are stable across
// tests, and the key derivation needs nothing but the origin string
const signingKeyFor = (origin: string): Uint8Array =>
  sha256(utf8ToBytes(`sattle-e2e mint signing key: ${origin}`));

// the key every output is signed with in invalid-signature mode: a real
// secp256k1 key, just never advertised by any mock mint
const FOREIGN_SIGNING_KEY = sha256(utf8ToBytes('sattle-e2e foreign signing key'));

// a melt's settle proof reveals a payment receipt - derived from the paid
// invoice so it is stable per payment and never collides with a note secret
const preimageFor = (pr: string): string => bytesToHex(sha256(utf8ToBytes(`preimage: ${pr}`)));

interface MockNoteInfoOptions {
  // note value in msat, reported as maxWithdrawable
  amountMsat?: number;
  // when set, the mint answers the ERROR envelope with this reason instead
  // (a reason matching /spent/i surfaces the "already been spent" UI)
  spentReason?: string;
  // the mint's signing pubkey, advertised as mintPubkey in responses -
  // defaults to the mock origin's real signing key (kit 0.8 refuses a
  // withdrawRequest that publishes none, so every mock mint has one)
  mintPubkey?: string;
}

interface MockTargetMintOptions {
  // the mint's signing pubkey (66 hex chars), advertised on the mint-address
  // (/.well-known/lnurlw/) and note-info responses - NEVER the payRequest:
  // LUD-25 announces it on the withdraw side only, and a too-generous mock
  // once masked a real bug. Defaults to the origin's real signing key.
  mintPubkey?: string;
  // the invoice this mint hands out (and reports back as settled) - keep it
  // amount-less (decodeBolt11AmountMsat returns null) so the kit skips the
  // amount cross-check
  invoice: string;
  // the payment preimage a settled verify reveals - a receipt distinct from
  // the wallet-chosen secret committed in the invoice comment
  preimage: string;
  // value of the note a claim mints, in msat
  noteAmountMsat: number;
  // optional payRequest metadata advertising a receive fee, e.g.
  // '[["text/plain","Mint fees: 2000,0"]]' (flat 2000 msat, 0 ppm)
  mintFeeMetadata?: string;
}

export class MintMocker {
  constructor(private page: Page) {}

  // when true, every minted output is signed with a foreign key: the
  // mutation lands mint-side, but the signature verifies against no key
  // this mint advertises - the wallet must keep the outputs unverified
  invalidSignatures = false;

  // every signature this mock issued, in order - lets a spec assert the
  // mint actually signed (the kit's requireSignatures policy makes an
  // unsigned success impossible to confuse with a signed one)
  readonly signaturesIssued: { origin: string; h: string; amountMsat: number }[] = [];

  // the mint's advertised signing pubkey for an origin (compressed, hex)
  signingPubkey(origin = MINT_ORIGIN): string {
    return bytesToHex(secp256k1.getPublicKey(signingKeyFor(origin), true));
  }

  // note id (sha256 of the secret) -> outstanding value in msat, per origin.
  // A real mint keys its ledger by the hash; the mock does the same so a
  // mutation can sign the output with the amount the inputs actually held.
  private readonly outstanding = new Map<string, number>();
  private readonly burned = new Set<string>();
  // invoices this mint reports as settled on its verify endpoint, per origin
  private readonly settledInvoices = new Map<string, string[]>();

  private noteKey(origin: string, noteId: string): string {
    return `${origin}|${noteId}`;
  }

  private sign(origin: string, h: string, amountMsat: number): string {
    const key = this.invalidSignatures ? FOREIGN_SIGNING_KEY : signingKeyFor(origin);
    // noble's 'recovered' layout is [recovery, r, s]; the wire layout is
    // r || s || recovery (the kit accepts either, the trailing layout is
    // what lnurl-mint emits)
    const signature = secp256k1.sign(noteSignatureDigestForHash(h, amountMsat), key, {
      format: 'recovered',
      prehash: false,
    });
    this.signaturesIssued.push({ origin, h, amountMsat });
    return bytesToHex(new Uint8Array([...signature.subarray(1), signature[0]]));
  }

  // mint outputs at the given hashes, burning the inputs - the ledger
  // transition every successful mutation makes
  private remint(
    origin: string,
    inputIds: string[],
    outputs: [h: string, amountMsat: number][],
  ): void {
    for (const id of inputIds) {
      this.outstanding.delete(this.noteKey(origin, id));
      this.burned.add(this.noteKey(origin, id));
    }
    for (const [h, amountMsat] of outputs) {
      this.outstanding.set(this.noteKey(origin, h), amountMsat);
    }
  }

  // The note's informational GET: a spec-shaped withdrawRequest, or the
  // ERROR envelope for a note the mint considers spent or never issued. The
  // kit validates that the service echoes back the queried k1, so read it
  // off the request. A first-seen k1 registers at the configured amount -
  // the mock's way of "issuing" the note a spec hands to the wallet.
  async mockNoteInfo(options: MockNoteInfoOptions, origin = MINT_ORIGIN): Promise<void> {
    const mintPubkey = options.mintPubkey ?? this.signingPubkey(origin);
    await this.page.route(
      new RegExp(`^${escapeRegExp(origin + NOTE_PATH)}\\?`),
      async (route: Route) => {
        if (options.spentReason !== undefined) {
          await fulfillJson(route, { status: 'ERROR', reason: options.spentReason });
          return;
        }
        const k1 = new URL(route.request().url()).searchParams.get('k1') ?? '';
        if (!/^[0-9a-f]{64}$/i.test(k1)) {
          // a by-hash lookup (h=) or a malformed k1 - this mock answers
          // secret-keyed info only
          await fulfillJson(route, { status: 'ERROR', reason: 'Note not found' });
          return;
        }
        const id = this.noteKey(origin, hashK1(k1));
        if (this.burned.has(id)) {
          await fulfillJson(route, { status: 'ERROR', reason: 'Note is spent' });
          return;
        }
        if (!this.outstanding.has(id)) {
          this.outstanding.set(id, options.amountMsat ?? 0);
        }
        const amountMsat = this.outstanding.get(id) ?? 0;
        await fulfillJson(route, {
          tag: 'withdrawRequest',
          callback: `${origin}${CALLBACK_PATH}`,
          k1,
          minWithdrawable: amountMsat,
          maxWithdrawable: amountMsat,
          defaultDescription: 'mock mint note',
          mintPubkey,
        });
      },
    );
  }

  // The settle proof a melt's verify URL serves: settled once the melt
  // landed, carrying the paid invoice and its preimage receipt.
  private async mockVerify(origin: string): Promise<void> {
    await this.page.route(
      new RegExp(`^${escapeRegExp(`${origin}/verify`)}`),
      async (route: Route) => {
        const pr = new URL(route.request().url()).searchParams.get('pr') ?? '';
        const settled = (this.settledInvoices.get(origin) ?? []).includes(pr);
        await fulfillJson(route, {
          settled,
          ...(settled ? { preimage: preimageFor(pr) } : {}),
          pr,
        });
      },
    );
  }

  // The mutating callback GET, signed per LUD-25:
  // - melt (k1 + pr): burns the input, answers OK with a settle-proof URL
  // - rotate (k1 + h): burns the input, mints at h for its full value
  // - split (k1... + amount + h + h2): carves amount off the inputs' total,
  //   minting h for it and h2 for the change
  // - merge (k1... + h): burns all inputs, mints h for their total
  // Every minted output's signature rides in the response (sig / sig2), and
  // a mutation naming an unknown or burned input is refused like a real
  // mint's. A byte-identical replay gets the same success - the mutations
  // are deterministic in their inputs, so the replayed answer re-derives
  // the same signatures.
  async mockMutationEndpoint(origin = MINT_ORIGIN): Promise<void> {
    await this.mockVerify(origin);
    await this.page.route(
      new RegExp(`^${escapeRegExp(origin + CALLBACK_PATH)}\\?`),
      async (route: Route) => {
        const url = new URL(route.request().url());
        const k1s = url.searchParams.getAll('k1');
        if (k1s.some((k1) => !/^[0-9a-f]{64}$/i.test(k1))) {
          await fulfillJson(route, { status: 'ERROR', reason: 'Note not found' });
          return;
        }
        const pr = url.searchParams.get('pr');
        const h = url.searchParams.get('h');
        const h2 = url.searchParams.get('h2');
        const amountRaw = url.searchParams.get('amount');
        const inputIds = k1s.map((k1) => hashK1(k1));
        const lookup = (id: string): number | 'unknown' | 'burned' => {
          const key = this.noteKey(origin, id);
          if (this.burned.has(key)) return 'burned';
          return this.outstanding.get(key) ?? 'unknown';
        };

        // melt: the note burns once the payment settles; the mock answers
        // OK (payment in flight) and the verify endpoint reports it settled
        if (pr !== null) {
          for (const id of inputIds) {
            const state = lookup(id);
            if (state === 'burned') {
              await fulfillJson(route, { status: 'ERROR', reason: 'Note is spent' });
              return;
            }
            if (state === 'unknown') {
              await fulfillJson(route, { status: 'ERROR', reason: 'Note not found' });
              return;
            }
          }
          this.remint(origin, inputIds, []);
          const paid = this.settledInvoices.get(origin) ?? [];
          paid.push(pr);
          this.settledInvoices.set(origin, paid);
          await fulfillJson(route, {
            status: 'OK',
            verify: `${origin}/verify?pr=${encodeURIComponent(pr)}`,
          });
          return;
        }

        // every other mutation mints outputs whose signatures the wallet
        // must be able to verify offline
        const total = inputIds.reduce((sum, id) => {
          const state = lookup(id);
          return typeof state === 'number' ? sum + state : sum;
        }, 0);
        for (const id of inputIds) {
          const state = lookup(id);
          if (state === 'burned') {
            await fulfillJson(route, { status: 'ERROR', reason: 'Note is spent' });
            return;
          }
          if (state === 'unknown') {
            await fulfillJson(route, { status: 'ERROR', reason: 'Note not found' });
            return;
          }
        }
        if (h !== null && h2 !== null && amountRaw !== null) {
          // split: amount carved off, the rest is change
          const amountMsat = Number(amountRaw);
          this.remint(origin, inputIds, [
            [h, amountMsat],
            [h2, total - amountMsat],
          ]);
          await fulfillJson(route, {
            status: 'OK',
            sig: this.sign(origin, h, amountMsat),
            sig2: this.sign(origin, h2, total - amountMsat),
          });
          return;
        }
        if (h !== null) {
          // rotate (one input) or merge (several): full value at h
          this.remint(origin, inputIds, [[h, total]]);
          await fulfillJson(route, { status: 'OK', sig: this.sign(origin, h, total) });
          return;
        }
        await fulfillJson(route, { status: 'ERROR', reason: 'Malformed mutation request' });
      },
    );
  }

  // The mint-address discovery endpoint (LUD-25): announces the signing key
  // and the node stats a real lnurl-mint advertises. `nodeCapacity` is msat
  // under its WIRE name (no suffix) - the kit has to map it onto
  // nodeCapacityMsat, which is exactly the 0.1.0 spread bug this exercises.
  // The payLink points back at the lnurlp route below, as prepareMint treats
  // it as the authoritative place to read the payRequest from.
  private async mockMintAddress(
    options: MockTargetMintOptions,
    origin: string,
    mintPubkey: string,
  ): Promise<void> {
    await this.page.route(
      new RegExp(`^${escapeRegExp(`${origin}/.well-known/lnurlw/`)}`),
      async (route: Route) => {
        await fulfillJson(route, {
          tag: 'withdrawRequest',
          callback: `${origin}${CALLBACK_PATH}`,
          minWithdrawable: 1000,
          maxWithdrawable: 100_000_000_000,
          mintPubkey,
          payLink: `${origin}/.well-known/lnurlp/mint`,
          nodeCapacity: 500_000_000,
          nodeNumChannels: 4,
          nodeNumPeers: 6,
        });
      },
    );
  }

  // Everything the target side of a transfer (or a Lightning receive)
  // needs: the mint-address discovery endpoint carrying the mint metadata,
  // the payRequest at the standard mint@ address, the invoice callback, an
  // immediately-settled verify endpoint revealing the payment receipt,
  // and note info at the wallet-chosen committed secret.
  async mockTargetMint(options: MockTargetMintOptions, origin = MINT2_ORIGIN): Promise<void> {
    const mintPubkey = options.mintPubkey ?? this.signingPubkey(origin);
    let stagedHash: string | null = null;
    let settled = false;
    await this.mockMintAddress(options, origin, mintPubkey);
    await this.mockMutationEndpoint(origin);
    await this.page.route(
      new RegExp(`^${escapeRegExp(origin + NOTE_PATH)}\\?`),
      async (route: Route) => {
        const k1 = new URL(route.request().url()).searchParams.get('k1') ?? '';
        if (!/^[0-9a-f]{64}$/i.test(k1) || !settled || hashK1(k1) !== stagedHash) {
          await fulfillJson(route, { status: 'ERROR', reason: 'Note not found' });
          return;
        }
        await fulfillJson(route, {
          tag: 'withdrawRequest',
          callback: `${origin}${CALLBACK_PATH}`,
          k1,
          minWithdrawable: options.noteAmountMsat,
          maxWithdrawable: options.noteAmountMsat,
          defaultDescription: 'mock minted note',
          mintPubkey,
        });
      },
    );
    await this.page.route(
      new RegExp(`^${escapeRegExp(`${origin}/.well-known/lnurlp/`)}`),
      async (route: Route) => {
        await fulfillJson(route, {
          tag: 'payRequest',
          callback: `${origin}/pay`,
          minSendable: 1000,
          maxSendable: 100_000_000_000,
          commentAllowed: 64,
          withdrawLink: `${origin}${NOTE_PATH}`,
          metadata: options.mintFeeMetadata ?? '[]',
        });
      },
    );
    await this.page.route(
      new RegExp(`^${escapeRegExp(`${origin}/pay`)}\\?`),
      async (route: Route) => {
        const request = new URL(route.request().url());
        const comment = request.searchParams.get('comment');
        const commitment = request.searchParams.get('h');
        if (!comment || !/^[0-9a-f]{64}$/i.test(comment) || commitment !== comment) {
          await fulfillJson(route, { status: 'ERROR', reason: 'Missing note commitment' });
          return;
        }
        stagedHash = comment.toLowerCase();
        await fulfillJson(route, {
          pr: options.invoice,
          verify: `${origin}/verify`,
        });
      },
    );
    await this.page.route(
      new RegExp(`^${escapeRegExp(MINT_ORIGIN + CALLBACK_PATH)}\\?`),
      async (route: Route) => {
        const paidInvoice = new URL(route.request().url()).searchParams.get('pr');
        if (paidInvoice !== options.invoice) {
          await route.fallback();
          return;
        }
        settled = true;
        await fulfillJson(route, { status: 'OK' });
      },
    );
    await this.page.route(
      new RegExp(`^${escapeRegExp(`${origin}/verify`)}`),
      async (route: Route) => {
        await fulfillJson(route, {
          settled,
          ...(settled ? { preimage: options.preimage } : {}),
          pr: options.invoice,
        });
      },
    );
  }
}
