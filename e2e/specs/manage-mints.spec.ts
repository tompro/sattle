import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import { buildNoteUrl, defaultRandomSecret } from 'lnurlcash-kit';
import { MINT_ORIGIN, NOTE_PATH } from '../helpers/MintMocker';
import { createFreshWallet } from '../helpers/wallet';

// a 33-byte compressed secp256k1 pubkey, hex - what the trusted-mint
// registry accepts
const MINT_PUBKEY = `02${'ab'.repeat(32)}`;

// the payRequest discovery behind a one-tap suggestion: the app resolves
// "@mint.600.wtf" to https://mint.600.wtf/.well-known/lnurlp/mint and reads
// the mint's signing key out of the response
const mockSuggestionMint = async (page: Page): Promise<void> => {
  const fulfill = async (route: import('@playwright/test').Route, body: unknown) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(body),
    });
  };
  // no mint-address discovery support - the app falls back to the LNURL-pay
  await page.route(/^https:\/\/mint\.600\.wtf\/\.well-known\/lnurlw\//, (route) =>
    fulfill(route, { status: 'ERROR', reason: 'not supported' }),
  );
  await page.route(/^https:\/\/mint\.600\.wtf\/\.well-known\/lnurlp\/mint/, (route) =>
    fulfill(route, {
      tag: 'payRequest',
      callback: 'https://mint.600.wtf/pay',
      minSendable: 1000,
      maxSendable: 100_000_000_000,
      withdrawLink: 'https://mint.600.wtf/note',
      mintPubkey: MINT_PUBKEY,
      metadata: '[]',
    }),
  );
};

test.describe('Manage mints', () => {
  test('trust a suggested mint, set it default, remove it', async ({ page }) => {
    await mockSuggestionMint(page);
    await createFreshWallet(page);

    // Settings -> Mints group -> Manage mints
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Manage mints' }).click();
    await expect(page).toHaveURL(/#\/settings\/mints$/);

    // empty state, and the public-mint suggestion is offered
    await expect(page.getByText('No mints yet', { exact: false })).toBeVisible();
    const suggestion = page.getByRole('button', { name: '@mint.600.wtf' });
    await expect(suggestion).toBeVisible();
    await suggestion.click();

    // the mint lands in the trusted list with its key fingerprint
    const mintsList = page.locator('.q-list', { hasText: 'Your mints' });
    await expect(mintsList.getByText('mint.600.wtf')).toBeVisible();
    await expect(mintsList.getByText(`Key ${MINT_PUBKEY.slice(0, 10)}`)).toBeVisible();
    await expect(mintsList.getByText('0 sats held here')).toBeVisible();
    // the trusted suggestion disappears from the suggestion row
    await expect(page.getByRole('button', { name: '@mint.600.wtf' })).toHaveCount(0);

    // set as default, then clear
    await mintsList.getByRole('button', { name: 'Set default' }).click();
    await expect(mintsList.locator('.q-badge', { hasText: 'Default' })).toBeVisible();
    await mintsList.getByRole('button', { name: 'Clear default' }).click();
    await expect(mintsList.locator('.q-badge')).toHaveCount(0);
    await mintsList.getByRole('button', { name: 'Set default' }).click();
    await expect(mintsList.locator('.q-badge', { hasText: 'Default' })).toBeVisible();

    // remove: confirm dialog, then back to the empty state
    await mintsList.getByRole('button', { name: 'Remove' }).click();
    const confirm = page.locator('.q-dialog', { hasText: 'Remove mint' });
    await confirm.getByRole('button', { name: 'Remove' }).click();
    await expect(mintsList.getByText('mint.600.wtf')).toHaveCount(0);
    await expect(page.getByText('No mints yet', { exact: false })).toBeVisible();
  });

  test('a mint with held notes cannot be removed', async ({ page, mint }) => {
    // hold a 21-sat note from the mock mint - holding funds locks the mint
    // against removal
    await mint.mockNoteInfo({ amountMsat: 21_000, mintPubkey: MINT_PUBKEY });
    await mint.mockRotateOk();
    await createFreshWallet(page);

    await page.getByRole('button', { name: 'Receive' }).click();
    const chooser = page.locator('.q-dialog', { hasText: 'Paste or scan a note' });
    await chooser.getByRole('button', { name: 'Bearer note' }).click();
    const dialog = page.locator('.q-dialog', { hasText: 'Receive bearer note' });
    await dialog
      .locator('textarea')
      .fill(buildNoteUrl(`${MINT_ORIGIN}${NOTE_PATH}`, defaultRandomSecret(), 21_000));
    await dialog.getByRole('button', { name: 'Receive', exact: true }).click();
    await expect(dialog.getByText('Received 21 sats')).toBeVisible();
    // the note advertises a mint key, so the first-contact trust prompt
    // opens as its own dialog - trust it (the mint stays locked either way,
    // since we hold its note)
    await page
      .locator('.q-dialog', { hasText: 'New mint' })
      .getByRole('button', { name: 'Trust this mint' })
      .click();
    await dialog.getByRole('button', { name: 'Done' }).click();

    await page.goto('/#/settings/mints');
    const mintsList = page.locator('.q-list', { hasText: 'Your mints' });
    await expect(mintsList.getByText('mint.test')).toBeVisible();
    await expect(mintsList.getByText('21 sats held here')).toBeVisible();

    await mintsList.getByRole('button', { name: 'Remove' }).click();
    const confirm = page.locator('.q-dialog', { hasText: 'Remove mint' });
    await confirm.getByRole('button', { name: 'Remove' }).click();

    // the locked-mint error surfaces as a friendly banner, entry stays
    await expect(
      page.locator('.q-banner', { hasText: "can't be removed while you hold notes" }),
    ).toBeVisible();
    await expect(mintsList.getByText('mint.test')).toBeVisible();
  });
});
