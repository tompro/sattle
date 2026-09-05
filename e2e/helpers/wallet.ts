import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { buildNoteUrl, defaultRandomSecret } from 'lnurlcash-kit';
import { MINT_ORIGIN, NOTE_PATH } from './MintMocker';
import type { MintMocker } from './MintMocker';

// Drives onboarding end to end on a fresh browser context: /#/welcome ->
// "Create wallet" (empty password = stored unencrypted) -> confirm the
// recovery phrase -> lands unlocked on /#/ with a 0-sats balance.
export const createFreshWallet = async (page: Page): Promise<void> => {
  await page.goto('/#/welcome');
  await page.getByRole('button', { name: 'Create wallet' }).click();
  await page.locator('.q-checkbox', { hasText: 'I wrote it down' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL(/#\/$/);
};

// Give a fresh wallet one verified, spendable note at the mock mint: the
// mock answers the note's informational GET and signs every mutation, and
// the receive's first-contact trust prompt is confirmed, pinning the mint's
// signing key so the wallet can verify what this mint mints.
export const fundMockMintWallet = async (
  page: Page,
  mint: MintMocker,
  amountMsat: number,
): Promise<void> => {
  await mint.mockNoteInfo({ amountMsat });
  await mint.mockMutationEndpoint();
  await createFreshWallet(page);

  await page.getByRole('button', { name: 'Receive' }).click();
  const chooser = page.locator('.q-dialog', { hasText: 'Paste or scan a note' });
  await chooser.getByRole('button', { name: 'Bearer note' }).click();
  const dialog = page.locator('.q-dialog', { hasText: 'Receive bearer note' });
  await dialog
    .locator('textarea')
    .fill(buildNoteUrl(`${MINT_ORIGIN}${NOTE_PATH}`, defaultRandomSecret(), amountMsat));
  await dialog.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(dialog.getByText(`Received ${Math.floor(amountMsat / 1000)} sats`)).toBeVisible();
  // the note advertises the mint's key, so the first-contact trust prompt
  // opens as its own dialog - trust it (that also pins the signing key)
  await page
    .locator('.q-dialog', { hasText: 'New mint' })
    .getByRole('button', { name: 'Trust this mint' })
    .click();
  await dialog.getByRole('button', { name: 'Done' }).click();
};
