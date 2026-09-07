import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import { fundMockMintWallet } from '../helpers/wallet';

// The Notes page (Settings -> Advanced -> Notes): per-note detail dialog,
// split/combine mutations against the mock mint, check & refresh rotation,
// and the hand-off into a selected-note move.

const AMOUNT_MSAT = 21_000; // 21 sats

// pick an option from a Quasar select identified by its label
const pickOption = async (page: Page, label: string, option: string) => {
  await page.locator('.q-field', { hasText: label }).click();
  await page.getByRole('option', { name: option }).click();
};

// split the wallet's 21-sat note into 8 + 13 sats through the notes UI
const splitInto8And13 = async (page: Page) => {
  await page.goto('/#/settings/notes');
  await page.locator('.q-page .q-item', { hasText: '21 sats' }).click();
  const dialog = page.locator('.q-dialog .note-detail');
  await dialog.getByRole('button', { name: 'Split' }).click();
  const splitDialog = page.locator('.q-dialog .split-dialog');
  await splitDialog.getByLabel('New note amount').fill('8');
  await splitDialog.getByRole('button', { name: 'Split' }).click();
  await expect(page.locator('.q-notification').getByText('Note split.')).toBeVisible();
};

test.describe('Notes page', () => {
  test('shows note details and check & refresh rotates to a fresh secret', async ({
    page,
    mint,
  }) => {
    await fundMockMintWallet(page, mint, AMOUNT_MSAT);

    await page.goto('/#/settings/notes');
    const list = page.locator('.q-page .q-list');
    await expect(list.getByText('21 sats')).toBeVisible();

    // the detail dialog shows the note's identity, status and actions
    await list.getByText('21 sats').click();
    const dialog = page.locator('.q-dialog .note-detail');
    await expect(dialog.getByText('mint.test')).toBeVisible();
    await expect(dialog.getByText('Note ID')).toBeVisible();
    await expect(dialog.getByText('Mint signing key')).toBeVisible();
    await expect(dialog.locator('.q-badge', { hasText: 'Valid locally' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Split' })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Move' })).toBeEnabled();

    // A refresh is a secret rotation of the same logical note, so private
    // local metadata must follow the active replacement.
    await dialog.getByLabel('Private label').fill('Emergency cash');
    await dialog.getByRole('button', { name: 'Save label' }).click();
    await expect(page.locator('.q-notification').getByText('Label saved.')).toBeVisible();

    // the check verifies the note mint-side and rotates it to a fresh
    // secret; completion is signalled by the toast
    await dialog.getByRole('button', { name: 'Check & refresh' }).click();
    await expect(
      page.locator('.q-notification').getByText('Note is valid and has a fresh secret.'),
    ).toBeVisible();

    // the checked copy is retired and the rotated note stands valid - the
    // wallet still holds exactly 21 spendable sats
    await page.goto('/#/settings/notes');
    await expect(page.locator('.q-page .q-item', { hasText: '21 sats' })).toHaveCount(2);
    await expect(page.locator('.q-page .q-badge', { hasText: 'Valid locally' })).toHaveCount(1);
    await expect(page.locator('.q-page .q-badge', { hasText: 'Spent' })).toHaveCount(1);
    await expect(
      page.locator('.q-page .q-item', { hasText: 'Emergency cash' }).getByText('Valid locally'),
    ).toBeVisible();

    // and the refresh is on the activity log
    await page.goto('/#/settings/activity');
    await expect(
      page.locator('.q-page').getByText('Checked and refreshed a 21 sat note from mint.test.'),
    ).toBeVisible();
  });

  test('splits a note and combines the pieces back once the change is refreshed', async ({
    page,
    mint,
  }) => {
    await fundMockMintWallet(page, mint, AMOUNT_MSAT);
    await splitInto8And13(page);

    // the split retires the original and mints the 8-sat target verified;
    // the 13-sat change stays unverified (an upper bound until refreshed),
    // so it can neither be selected nor combined yet
    const list = page.locator('.q-page .q-list');
    await expect(list.locator('.q-item', { hasText: '8 sats' })).toHaveCount(1);
    await expect(list.locator('.q-item', { hasText: '13 sats' })).toHaveCount(1);
    await expect(list.locator('.q-item', { hasText: '13 sats' })).toContainText('Unverified');
    await expect(page.locator('.q-checkbox[aria-label="Select 13 sat note"]')).toBeDisabled();

    // refreshing the change note verifies and rotates it
    await list.locator('.q-item', { hasText: '13 sats' }).click();
    const dialog = page.locator('.q-dialog .note-detail');
    await dialog.getByRole('button', { name: 'Check & refresh' }).click();
    await expect(
      page.locator('.q-notification').getByText('Note is valid and has a fresh secret.'),
    ).toBeVisible();

    // now both pieces can be selected and combined back (the detail dialog
    // stays open on the retired copy - dismiss it to reach the list)
    await page.keyboard.press('Escape');
    await expect(page.locator('.note-detail')).toHaveCount(0);
    await page.locator('.q-checkbox[aria-label="Select 8 sat note"]').click();
    await page.locator('.q-checkbox[aria-label="Select 13 sat note"]:not(.disabled)').click();
    const mergeBar = page.locator('.merge-bar');
    await expect(mergeBar.getByText('2 selected')).toBeVisible();
    await mergeBar.getByRole('button', { name: 'Combine' }).click();

    // one valid 21-sat note again; every intermediate copy shows as spent
    await expect(page.locator('.q-notification').getByText('Notes combined.')).toBeVisible();
    await expect(page.locator('.q-page .q-badge', { hasText: 'Valid locally' })).toHaveCount(1);
    await expect(page.locator('.q-page .q-badge', { hasText: 'Spent' })).toHaveCount(4);

    // no sats were created or destroyed along the way
    await page.goto('/#/');
    await expect(page.locator('.balance-card .text-h2')).toHaveText('21');
  });

  test('moving from a note prefills its amount and locks the source to that note', async ({
    page,
    mint,
  }) => {
    await fundMockMintWallet(page, mint, AMOUNT_MSAT);
    await splitInto8And13(page);

    // move the 8-sat piece: the move form opens with the note's mint and
    // amount prefilled, and the source select is locked
    await page.locator('.q-page .q-item', { hasText: '8 sats' }).click();
    const dialog = page.locator('.q-dialog .note-detail');
    await dialog.getByRole('button', { name: 'Move' }).click();

    await expect(page).toHaveURL(/#\/settings\/move\?noteId=/);
    const sourceField = page.locator('.q-field', { hasText: 'From mint' });
    await expect(sourceField).toHaveClass(/q-field--disabled/);
    await expect(sourceField).toContainText('mint.test - 8 sats available');
    await expect(page.getByLabel('Amount')).toHaveValue('8');

    // Max tops up to the selected note alone, not the wallet's 21 sats
    await page.getByRole('button', { name: 'Max' }).click();
    await expect(page.getByLabel('Amount')).toHaveValue('8');

    // and asking for more than the locked note is refused inline
    await pickOption(page, 'To mint', 'Another mint…');
    await page.getByLabel('Target mint address').fill('@mint2.test');
    await page.getByLabel('Amount').fill('9');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(
      page.locator('.q-banner', { hasText: 'more than the 8 sats spendable at mint.test' }),
    ).toBeVisible();
  });
});
