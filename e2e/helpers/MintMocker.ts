import type { Page, Route } from '@playwright/test';

// The mock mint lives on a .test origin that never resolves - every request
// to it is intercepted by Playwright and fulfilled in-process, so the specs
// never touch the network. Protocol shapes mirror lnurlcash-kit's client:
// the informational GET on the note URL (fetchNoteInfo) expects an LUD-03
// withdrawRequest echoing the queried k1, or the LNURL ERROR envelope; the
// rotation GET on the callback (rotateNote) expects {status: "OK"}.
export const MINT_ORIGIN = 'https://mint.test';
export const NOTE_PATH = '/note';
export const CALLBACK_PATH = '/callback';

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
}

export class MintMocker {
  constructor(private page: Page) {}

  // The note's informational GET: a spec-shaped withdrawRequest, or the
  // ERROR envelope for a note the mint considers spent. The kit validates
  // that the service echoes back the queried k1, so read it off the request.
  async mockNoteInfo(options: MockNoteInfoOptions): Promise<void> {
    await this.page.route(
      new RegExp(`^${escapeRegExp(MINT_ORIGIN + NOTE_PATH)}\\?`),
      async (route: Route) => {
        if (options.spentReason !== undefined) {
          await fulfillJson(route, { status: 'ERROR', reason: options.spentReason });
          return;
        }
        const k1 = new URL(route.request().url()).searchParams.get('k1') ?? '';
        await fulfillJson(route, {
          tag: 'withdrawRequest',
          callback: `${MINT_ORIGIN}${CALLBACK_PATH}`,
          k1,
          minWithdrawable: options.amountMsat ?? 0,
          maxWithdrawable: options.amountMsat ?? 0,
          defaultDescription: 'mock mint note',
        });
      },
    );
  }

  // The rotation callback GET (k1 + h params): confirm with the OK envelope.
  // No sig is returned - a plain LUD-03-style service that speaks rotate but
  // does not sign notes.
  async mockRotateOk(): Promise<void> {
    await this.page.route(
      new RegExp(`^${escapeRegExp(MINT_ORIGIN + CALLBACK_PATH)}\\?`),
      async (route: Route) => {
        await fulfillJson(route, { status: 'OK' });
      },
    );
  }
}
