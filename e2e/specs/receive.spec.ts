import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import { buildNoteUrl, defaultRandomSecret } from 'lnurlcash-kit';
import { MINT_ORIGIN, NOTE_PATH } from '../helpers/MintMocker';
import { createFreshWallet } from '../helpers/wallet';

const AMOUNT_MSAT = 21_000; // 21 sats

// a syntactically valid bearer note against the mock mint - the k1 is a
// fresh random secret, so every test redeems a distinct note
const freshNoteUrl = (): string =>
  buildNoteUrl(`${MINT_ORIGIN}${NOTE_PATH}`, defaultRandomSecret(), AMOUNT_MSAT);

// main page -> Receive -> "Bearer note" -> paste -> redeem
const redeemNote = async (page: Page, noteUrl: string): Promise<void> => {
  await page.getByRole('button', { name: 'Receive' }).click();
  const chooser = page.locator('.q-dialog', { hasText: 'Paste or scan a note' });
  await chooser.getByRole('button', { name: 'Bearer note' }).click();

  const dialog = page.locator('.q-dialog', { hasText: 'Receive bearer note' });
  await dialog.locator('textarea').fill(noteUrl);
  await dialog.getByRole('button', { name: 'Receive', exact: true }).click();
};

test.describe('Receive bearer note', () => {
  test('redeeming a valid note updates the balance', async ({ page, mint }) => {
    await mint.mockNoteInfo({ amountMsat: AMOUNT_MSAT });
    await mint.mockRotateOk();
    await createFreshWallet(page);

    const dialog = page.locator('.q-dialog', { hasText: 'Receive bearer note' });
    await redeemNote(page, freshNoteUrl());

    // success screen, then the balance reflects the redeemed amount
    await expect(dialog.getByText('Received 21 sats')).toBeVisible();
    // no "stored unconfirmed" / rotation banner: both mocked mint endpoints
    // were really consumed (the kit bug this guards against silently fell
    // back to the declared amount without any request)
    await expect(dialog.locator('.q-banner')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('.balance-card .text-h2')).toHaveText('21');
  });

  test('a spent note shows the spent error and leaves the balance untouched', async ({
    page,
    mint,
  }) => {
    await mint.mockNoteInfo({ spentReason: 'note already spent' });
    await createFreshWallet(page);

    await redeemNote(page, freshNoteUrl());

    await expect(
      page.locator('.q-banner', { hasText: 'This note has already been spent.' }),
    ).toBeVisible();

    // nothing was stored: back on the main page the balance is still 0
    await page.keyboard.press('Escape');
    await expect(page.locator('.balance-card .text-h2')).toHaveText('0');
  });
});
