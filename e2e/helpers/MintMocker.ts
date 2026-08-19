import type { Page, Route } from '@playwright/test';

// The mock mint lives on a .test origin that never resolves - every request
// to it is intercepted by Playwright and fulfilled in-process, so the specs
// never touch the network. Protocol shapes mirror lnurlcash-kit's client:
// the informational GET on the note URL (fetchNoteInfo) expects an LUD-03
// withdrawRequest echoing the queried k1, or the LNURL ERROR envelope; the
// rotation GET on the callback (rotateNote) expects {status: "OK"}. The same
// callback shape also answers a melt (meltNote sends k1 + pr to the same
// callback and only requires status "OK").
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

interface MockNoteInfoOptions {
  // note value in msat, reported as maxWithdrawable
  amountMsat?: number;
  // when set, the mint answers the ERROR envelope with this reason instead
  // (a reason matching /spent/i surfaces the "already been spent" UI)
  spentReason?: string;
  // the mint's signing pubkey, advertised as mintPubkey in responses
  mintPubkey?: string;
}

interface MockTargetMintOptions {
  // the mint's signing pubkey (66 hex chars), advertised in the payRequest
  // and note responses
  mintPubkey: string;
  // the invoice this mint hands out (and reports back as settled) - keep it
  // amount-less (decodeBolt11AmountMsat returns null) so the kit skips the
  // amount cross-check
  invoice: string;
  // the payment preimage a settled verify reveals - 64 hex chars (it IS the
  // claimed note's secret)
  preimage: string;
  // value of the note a claim mints, in msat
  noteAmountMsat: number;
}

export class MintMocker {
  constructor(private page: Page) {}

  // The note's informational GET: a spec-shaped withdrawRequest, or the
  // ERROR envelope for a note the mint considers spent. The kit validates
  // that the service echoes back the queried k1, so read it off the request.
  async mockNoteInfo(options: MockNoteInfoOptions, origin = MINT_ORIGIN): Promise<void> {
    await this.page.route(
      new RegExp(`^${escapeRegExp(origin + NOTE_PATH)}\\?`),
      async (route: Route) => {
        if (options.spentReason !== undefined) {
          await fulfillJson(route, { status: 'ERROR', reason: options.spentReason });
          return;
        }
        const k1 = new URL(route.request().url()).searchParams.get('k1') ?? '';
        await fulfillJson(route, {
          tag: 'withdrawRequest',
          callback: `${origin}${CALLBACK_PATH}`,
          k1,
          minWithdrawable: options.amountMsat ?? 0,
          maxWithdrawable: options.amountMsat ?? 0,
          defaultDescription: 'mock mint note',
          ...(options.mintPubkey ? { mintPubkey: options.mintPubkey } : {}),
        });
      },
    );
  }

  // The mutating callback GET: rotate (k1 + h params) and melt (k1 + pr
  // params) both expect a plain {status: "OK"} confirmation. No sig is
  // returned - a plain LUD-03-style service that does not sign notes.
  async mockRotateOk(origin = MINT_ORIGIN): Promise<void> {
    await this.page.route(
      new RegExp(`^${escapeRegExp(origin + CALLBACK_PATH)}\\?`),
      async (route: Route) => {
        await fulfillJson(route, { status: 'OK' });
      },
    );
  }

  // A mint that never answers its mint-address discovery endpoint with
  // anything usable - prepareMint treats that as "no mint-address support"
  // and falls back to the plain LNURL-pay guess.
  private async mockNoMintAddress(origin: string): Promise<void> {
    await this.page.route(
      new RegExp(`^${escapeRegExp(`${origin}/.well-known/lnurlw/`)}`),
      async (route: Route) => {
        await fulfillJson(route, { status: 'ERROR', reason: 'not supported' });
      },
    );
  }

  // Everything the target side of a transfer (or a Lightning receive)
  // needs: the payRequest at the standard mint@ address, the invoice
  // callback, an immediately-settled verify endpoint revealing the
  // preimage, and the note info + rotate the claim then performs.
  async mockTargetMint(options: MockTargetMintOptions, origin = MINT2_ORIGIN): Promise<void> {
    await this.mockNoMintAddress(origin);
    await this.mockNoteInfo(
      { amountMsat: options.noteAmountMsat, mintPubkey: options.mintPubkey },
      origin,
    );
    await this.mockRotateOk(origin);
    await this.page.route(
      new RegExp(`^${escapeRegExp(`${origin}/.well-known/lnurlp/`)}`),
      async (route: Route) => {
        await fulfillJson(route, {
          tag: 'payRequest',
          callback: `${origin}/pay`,
          minSendable: 1000,
          maxSendable: 100_000_000_000,
          withdrawLink: `${origin}${NOTE_PATH}`,
          mintPubkey: options.mintPubkey,
          metadata: '[]',
        });
      },
    );
    await this.page.route(
      new RegExp(`^${escapeRegExp(`${origin}/pay`)}\\?`),
      async (route: Route) => {
        await fulfillJson(route, {
          pr: options.invoice,
          verify: `${origin}/verify`,
        });
      },
    );
    await this.page.route(
      new RegExp(`^${escapeRegExp(`${origin}/verify`)}`),
      async (route: Route) => {
        await fulfillJson(route, {
          settled: true,
          preimage: options.preimage,
          pr: options.invoice,
        });
      },
    );
  }
}
