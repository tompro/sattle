import { test, expect } from '../fixtures';
import { createFreshWallet, fundMockMintWallet } from '../helpers/wallet';
import { hexToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent } from 'nostr-tools/pure';
import { decrypt as nip04Decrypt, encrypt as nip04Encrypt } from 'nostr-tools/nip04';

// M5 Nostr Wallet Connect settings surface. No real relay traffic: the one
// test that runs the service injects a fake transport through the dev-only
// window hook (stores/nwc.ts) before enabling - every other test stays
// UI-only with the service off.

// a Nostr event as the fake transport carries it - the plain JSON shape
// NIP-47 requests and responses take on the wire
type WireEvent = {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
};

type FakeSub = { closed: boolean; close: () => void };

declare global {
  interface Window {
    __sattleNwcTest: { setTransport: (transport: unknown) => void };
    __nwcSubs: FakeSub[];
    __nwcPublished: WireEvent[];
    __nwcOnEvent?: (event: WireEvent) => void;
  }
}

const openNwcPage = async (page: import('@playwright/test').Page) => {
  await page.goto('/#/settings/nwc');
};

test.describe('NWC settings page', () => {
  test('renders the foreground-only explainer and the Connections settings entries link out', async ({
    page,
  }) => {
    await createFreshWallet(page);

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Nostr Wallet Connect' }).click();
    await expect(page).toHaveURL(/#\/settings\/nwc$/);

    // the honest foreground-only explanation, not a feature promise
    await expect(page.getByText('How this works', { exact: true })).toBeVisible();
    await expect(
      page.getByText('only while it is open and unlocked', { exact: false }),
    ).toBeVisible();
    await expect(page.getByText('dropped if they are more than ten minutes old')).toBeVisible();

    // service off by default, toggle offered
    await expect(page.locator('.q-toggle[aria-label="Enable Nostr Wallet Connect"]')).toBeVisible();
    await expect(page.locator('[data-nwc-status]')).toHaveCount(0);

    // empty connection list + create form with default relays
    await expect(page.getByText('No connections yet')).toBeVisible();
    await expect(page.getByText('wss://relay.damus.io')).toBeVisible();

    // the second Connections entry lands on the backup page's relay management
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('button', { name: 'Nostr backup & relays' }).click();
    await expect(page).toHaveURL(/#\/settings\/backup$/);
    await expect(page.getByText('Nostr backup', { exact: true })).toBeVisible();
  });

  test('creating a connection shows the connection string once, and never again', async ({
    page,
  }) => {
    await createFreshWallet(page);
    await openNwcPage(page);

    await page.getByRole('button', { name: 'Create connection' }).click();

    // the one-time reveal: warning, QR, copy button, and the string itself
    await expect(page.getByText('shown only once', { exact: false })).toBeVisible();
    const uri = (await page.locator('.nwc-connection-string').textContent())?.trim();
    expect(uri).toBeTruthy();
    if (!uri) throw new Error('Expected the one-time NWC connection string.');

    // a well-formed NIP-47 connection string
    const url = new URL(uri);
    expect(url.protocol).toBe('nostr+walletconnect:');
    expect(url.host).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get('secret')).toMatch(/^[0-9a-f]{64}$/);
    const relays = url.searchParams.getAll('relay');
    expect(relays.length).toBeGreaterThan(0);
    expect(relays).toContain('wss://relay.damus.io');

    // the connection joined the list, WITHOUT the string
    await expect(page.locator('.q-item', { hasText: 'Client ' }).first()).toBeVisible();

    // dismiss, leave and return: the string is gone for good
    await page.getByRole('button', { name: "Done - I've saved it" }).click();
    await expect(page.locator('.nwc-connection-string')).toHaveCount(0);
    await page.goto('/#/settings');
    await openNwcPage(page);
    await expect(page.locator('.q-item', { hasText: 'Client ' }).first()).toBeVisible();
    await expect(page.locator('.nwc-connection-string')).toHaveCount(0);
    await expect(page.getByText('nostr+walletconnect://')).toHaveCount(0);
  });

  test('editing a connection budget persists across a reload', async ({ page }) => {
    await createFreshWallet(page);
    await openNwcPage(page);
    await page.getByRole('button', { name: 'Create connection' }).click();
    await page.getByRole('button', { name: "Done - I've saved it" }).click();

    // the default budget, then edit it
    const item = page.locator('.q-item', { hasText: 'Client' });
    await expect(item.getByText('10,000 sats per day')).toBeVisible();
    await item.getByRole('button', { name: 'Edit budget' }).click();
    const dialog = page.locator('.q-dialog');
    await dialog.getByText('100,000 sats per day', { exact: true }).click();
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(item.getByText('100,000 sats per day')).toBeVisible();

    await page.reload();
    await expect(
      page.locator('.q-item', { hasText: 'Client' }).getByText('100,000 sats per day'),
    ).toBeVisible();
  });

  test('disabling the service stops every relay subscription', async ({ page }) => {
    await createFreshWallet(page);
    await openNwcPage(page);

    // fake transport BEFORE enabling: no real WebSocket, and closable subs
    await page.evaluate(() => {
      window.__nwcSubs = [];
      window.__sattleNwcTest.setTransport({
        publish: () => Promise.resolve(),
        subscribe: () => {
          const sub: FakeSub = {
            closed: false,
            close() {
              this.closed = true;
            },
          };
          window.__nwcSubs.push(sub);
          return sub;
        },
      });
    });

    // a connection to serve, then enable
    await page.getByRole('button', { name: 'Create connection' }).click();
    await page.getByRole('button', { name: "Done - I've saved it" }).click();
    await page.locator('.q-toggle[aria-label="Enable Nostr Wallet Connect"]').click();

    await expect(page.getByText('Service running', { exact: false })).toBeVisible();
    await expect.poll(async () => page.evaluate(() => window.__nwcSubs.length)).toBeGreaterThan(0);

    // disable: the status disappears and every subscription is closed
    await page.locator('.q-toggle[aria-label="Enable Nostr Wallet Connect"]').click();
    await expect(page.locator('[data-nwc-status]')).toHaveCount(0);
    await expect
      .poll(async () => page.evaluate(() => window.__nwcSubs.every((sub) => sub.closed)))
      .toBe(true);
  });

  test('a client pays an invoice and the wallet settles it at the mint', async ({ page, mint }) => {
    // a funded wallet: 50 sats at the mock mint, its signing key pinned
    await fundMockMintWallet(page, mint, 50_000);
    await expect(page.locator('.balance-card .text-h2')).toHaveText('50');

    // create a connection and read its one-time URI: the wallet service
    // pubkey is the host, the client secret the `secret` param
    await openNwcPage(page);
    await page.getByRole('button', { name: 'Create connection' }).click();
    const uri = (await page.locator('.nwc-connection-string').textContent())?.trim();
    expect(uri).toBeTruthy();
    if (!uri) throw new Error('Expected the one-time NWC connection string.');
    await page.getByRole('button', { name: "Done - I've saved it" }).click();
    const connectionUrl = new URL(uri);
    const walletServicePubkey = connectionUrl.host;
    const clientSecret = connectionUrl.searchParams.get('secret') ?? '';

    // a fake transport that captures the request handler and every
    // published event, installed before the service starts
    await page.evaluate(() => {
      window.__nwcSubs = [];
      window.__nwcPublished = [];
      window.__sattleNwcTest.setTransport({
        publish: (_relays: string[], event: WireEvent) => {
          window.__nwcPublished.push(event);
          return Promise.resolve();
        },
        subscribe: (_relays: string[], _filter: unknown, onEvent: (event: WireEvent) => void) => {
          window.__nwcOnEvent = onEvent;
          const sub: FakeSub = {
            closed: false,
            close() {
              this.closed = true;
            },
          };
          window.__nwcSubs.push(sub);
          return sub;
        },
      });
    });
    await page.locator('.q-toggle[aria-label="Enable Nostr Wallet Connect"]').click();
    await expect(page.getByText('Service running', { exact: false })).toBeVisible();
    await expect.poll(async () => page.evaluate(() => typeof window.__nwcOnEvent)).toBe('function');

    // a 21-sat invoice the mint will settle; the request is exactly what a
    // NIP-47 client sends: kind 23194, NIP-04 encrypted to the service,
    // schnorr-signed by the connection's client secret
    const invoice = 'lnbc210n1pjqrstuvwxyz';
    const content = await nip04Encrypt(
      clientSecret,
      walletServicePubkey,
      JSON.stringify({ method: 'pay_invoice', params: { invoice } }),
    );
    const request = finalizeEvent(
      {
        kind: 23194,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['p', walletServicePubkey],
          ['encryption', 'nip04'],
        ],
        content,
      },
      hexToBytes(clientSecret),
    );
    await page.evaluate((event) => window.__nwcOnEvent?.(event), request);

    // the service pays and answers on the same scheme
    await expect
      .poll(async () =>
        page.evaluate(
          (id) =>
            window.__nwcPublished.find(
              (event) =>
                event.kind === 23195 && event.tags.some((tag) => tag[0] === 'e' && tag[1] === id),
            ) ?? null,
          request.id,
        ),
      )
      .not.toBeNull();
    const responseEvent = await page.evaluate(
      (id) =>
        window.__nwcPublished.find(
          (event) =>
            event.kind === 23195 && event.tags.some((tag) => tag[0] === 'e' && tag[1] === id),
        ) ?? null,
      request.id,
    );
    if (!responseEvent) throw new Error('the service published no response');
    const response: unknown = JSON.parse(
      await nip04Decrypt(clientSecret, walletServicePubkey, responseEvent.content),
    );
    if (typeof response !== 'object' || response === null) {
      throw new Error('the service response is not an object');
    }
    const result = response as { result_type?: unknown; error?: unknown; result?: unknown };
    expect(result.result_type).toBe('pay_invoice');
    expect(result.error).toBeNull();
    // the receipt is the melt's payment preimage from the mint's own
    // settle proof - 64 hex chars, never a note secret
    const payload = result.result as { preimage?: unknown };
    expect(payload.preimage).toMatch(/^[0-9a-f]{64}$/);

    // the wallet paid 21 of its 50 sats; the change stays in the wallet
    await page.goto('/#/');
    await expect(page.locator('.balance-card .text-h2')).toHaveText('29');
  });
});
