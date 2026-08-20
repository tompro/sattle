import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import { buildNoteUrl, defaultRandomSecret } from 'lnurlcash-kit';
import { MINT_ORIGIN, MINT2_ORIGIN, NOTE_PATH } from '../helpers/MintMocker';
import { createFreshWallet } from '../helpers/wallet';

const AMOUNT_MSAT = 50_000; // 50 sats
const MINT_PUBKEY = `02${'ab'.repeat(32)}`;
const TARGET_PUBKEY = `03${'cd'.repeat(32)}`;
// 64 hex chars - a valid preimage (it becomes the claimed note's secret)
const PREIMAGE = 'ef'.repeat(32);
// amount-less by decodeBolt11AmountMsat, so the kit skips its invoice
// amount cross-check against the requested value
const INVOICE = 'lnmock1transfer';

// give the wallet a verified, spendable 50-sat note at the source mint
const fundSourceMint = async (page: Page, mint: import('../helpers/MintMocker').MintMocker) => {
  await mint.mockNoteInfo({ amountMsat: AMOUNT_MSAT, mintPubkey: MINT_PUBKEY });
  await mint.mockRotateOk();
  await createFreshWallet(page);

  await page.getByRole('button', { name: 'Receive' }).click();
  const chooser = page.locator('.q-dialog', { hasText: 'Paste or scan a note' });
  await chooser.getByRole('button', { name: 'Bearer note' }).click();
  const dialog = page.locator('.q-dialog', { hasText: 'Receive bearer note' });
  await dialog
    .locator('textarea')
    .fill(buildNoteUrl(`${MINT_ORIGIN}${NOTE_PATH}`, defaultRandomSecret(), AMOUNT_MSAT));
  await dialog.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(dialog.getByText('Received 50 sats')).toBeVisible();
  // the note advertises a mint key, so the first-contact trust prompt opens
  // as its own dialog - trust it (that also locks the mint)
  await page
    .locator('.q-dialog', { hasText: 'New mint' })
    .getByRole('button', { name: 'Trust this mint' })
    .click();
  await dialog.getByRole('button', { name: 'Done' }).click();
};

// pick an option from a Quasar select identified by its label
const pickOption = async (page: Page, label: string, option: string) => {
  await page.locator('.q-field', { hasText: label }).click();
  await page.getByRole('option', { name: option }).click();
};

test.describe('Move funds', () => {
  test('form renders and blocks bad amounts', async ({ page, mint }) => {
    await fundSourceMint(page, mint);

    await page.goto('/#/settings/move');

    // the source select lists only mints with spendable balance
    await pickOption(page, 'From mint', 'mint.test - 50 sats available');
    await pickOption(page, 'To mint', 'Another mint…');
    await page.getByLabel('Target mint address').fill('@mint2.test');

    // no amount: Continue stays disabled
    const continueBtn = page.getByRole('button', { name: 'Continue' });
    await expect(continueBtn).toBeDisabled();

    // over the source balance: blocked with an inline error
    await page.getByLabel('Amount').fill('51');
    await continueBtn.click();
    await expect(
      page.locator('.q-banner', { hasText: 'more than the 50 sats spendable at mint.test' }),
    ).toBeVisible();

    // the Max helper fills the source balance and passes validation
    await page.getByRole('button', { name: 'Max' }).click();
    await expect(page.getByLabel('Amount')).toHaveValue('50');
    await continueBtn.click();
    await expect(page.getByText('mint.test')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Move now' })).toBeVisible();
  });

  test('the Max helper discounts the target mint fee', async ({ page, mint }) => {
    await fundSourceMint(page, mint);
    // the target mint advertises a flat 2-sat receive fee (2000 msat, 0 ppm)
    await mint.mockTargetMint(
      {
        mintPubkey: TARGET_PUBKEY,
        invoice: INVOICE,
        preimage: PREIMAGE,
        noteAmountMsat: AMOUNT_MSAT,
        mintFeeMetadata: '[["text/plain","Mint fees: 2000,0"]]',
      },
      MINT2_ORIGIN,
    );

    await page.goto('/#/settings/move');
    await pickOption(page, 'From mint', 'mint.test - 50 sats available');
    await pickOption(page, 'To mint', 'Another mint…');
    await page.getByLabel('Target mint address').fill('@mint2.test');

    // the fee quote lands (caption shown), then Max fills 50 - 2 = 48
    await expect(page.getByText(/receive fee/)).toBeVisible();
    await page.getByRole('button', { name: 'Max' }).click();
    await expect(page.getByLabel('Amount')).toHaveValue('48');
  });

  test('a two-mint transfer moves the balance', async ({ page, mint }) => {
    await fundSourceMint(page, mint);
    // the target mint: hands out the invoice, reports it settled with the
    // preimage, and answers the claim's note info + rotation
    await mint.mockTargetMint(
      {
        mintPubkey: TARGET_PUBKEY,
        invoice: INVOICE,
        preimage: PREIMAGE,
        noteAmountMsat: AMOUNT_MSAT,
      },
      MINT2_ORIGIN,
    );

    await page.goto('/#/settings/move');
    await pickOption(page, 'From mint', 'mint.test - 50 sats available');
    await pickOption(page, 'To mint', 'Another mint…');
    await page.getByLabel('Target mint address').fill('@mint2.test');
    await page.getByLabel('Amount').fill('50');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Move now' }).click();

    // settled: success screen with the fee summary (scoped to the page -
    // a toast repeats the "Moved" message)
    await expect(page.locator('.q-page').getByText('Moved 50 sats')).toBeVisible();
    await expect(page.getByText('No fees were charged.')).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();

    // the balance survived the move, now held at the target mint
    await page.goto('/#/');
    await expect(page.locator('.balance-card .text-h2')).toHaveText('50');
    await page.goto('/#/settings/mints');
    const mintsList = page.locator('.q-list', { hasText: 'Your mints' });
    await expect(mintsList.getByText('mint2.test')).toBeVisible();
    await expect(mintsList.getByText('50 sats held here')).toBeVisible();
  });

  test('a locked wallet is sent back to the main page', async ({ page }) => {
    // no wallet on this device at all: the guard redirects to /
    await page.goto('/#/settings/move');
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByText('Welcome to sattle')).toBeVisible();
  });
});
