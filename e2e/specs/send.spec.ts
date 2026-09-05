import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import {
  fromBech32Lnurl,
  noteDeclaredAmount,
  noteK1,
  noteSignature,
  verifyNoteSignature,
} from 'lnurlcash-kit';
import { fundMockMintWallet } from '../helpers/wallet';

const FUNDING_MSAT = 50_000; // 50 sats
const SEND_MSAT = 21_000; // 21 sats

// give the wallet a verified, spendable 50-sat note at the mock mint, with
// the mint's signing key pinned through the first-contact trust prompt
const fundMockMint = async (page: Page, mint: import('../helpers/MintMocker').MintMocker) => {
  await fundMockMintWallet(page, mint, FUNDING_MSAT);
  await expect(page.locator('.balance-card .text-h2')).toHaveText('50');
};

// prepare a note hand-over and read the displayed note off the clipboard
const prepareNote = async (page: Page, sats: string): Promise<string> => {
  await page.getByRole('button', { name: 'Send' }).click();
  const chooser = page.locator('.q-dialog', { hasText: 'Hand someone a note' });
  await chooser.getByRole('button', { name: 'Bearer note' }).click();
  const dialog = page.locator('.q-dialog', { hasText: 'Send a note' });
  await dialog.getByLabel('Amount (sats)').fill(sats);
  await dialog.getByRole('button', { name: 'Prepare note' }).click();
  await expect(dialog.getByText('Tap to reveal')).toBeVisible();
  await dialog.getByRole('button', { name: 'Copy' }).click();
  return page.evaluate(() => navigator.clipboard.readText());
};

test.describe('Send a note', () => {
  test('a carved note carries a signature that verifies against the mint', async ({
    page,
    mint,
  }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await fundMockMint(page, mint);

    // the mint signed the split's two outputs (the carved note and the
    // change), and the note the dialog hands over carries that signature
    // in its URL
    const beforeSend = mint.signaturesIssued.length;
    const bech32 = await prepareNote(page, '21');
    const issued = mint.signaturesIssued
      .slice(beforeSend)
      .map((entry) => entry.amountMsat)
      .sort((a, b) => a - b);
    expect(issued).toEqual([SEND_MSAT, FUNDING_MSAT - SEND_MSAT]);
    const url = fromBech32Lnurl(bech32.trim());
    expect(url).not.toBeNull();
    if (!url) throw new Error('the dialog handed over an undecodable note');
    const k1 = noteK1(url);
    const amountMsat = noteDeclaredAmount(url);
    const signature = noteSignature(url);
    expect(k1).not.toBeNull();
    expect(amountMsat).toBe(SEND_MSAT);
    expect(signature).not.toBeNull();
    if (!k1 || amountMsat === null || !signature) throw new Error('the note lacks its sig param');
    // the offline proof verifies against the key the mint advertised and
    // the wallet pinned - this is what marked the carved note spendable
    expect(verifyNoteSignature(k1, amountMsat, signature, mint.signingPubkey())).toBe(true);

    // keep the note: nothing was handed over, the balance is untouched
    const dialog = page.locator('.q-dialog', { hasText: 'Send a note' });
    await dialog.getByRole('button', { name: 'Keep in wallet' }).click();
    await expect(page.locator('.balance-card .text-h2')).toHaveText('50');
  });

  test('outputs the mint signs with a foreign key never become spendable', async ({
    page,
    mint,
  }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await fundMockMint(page, mint);

    // the mint's mutations land but are signed by a key it never advertised
    mint.invalidSignatures = true;
    const bech32 = await prepareNote(page, '21');

    // the note exists (the split landed mint-side), but its offline proof
    // verifies against no key this mint publishes
    const url = fromBech32Lnurl(bech32.trim());
    if (!url) throw new Error('the dialog handed over an undecodable note');
    const k1 = noteK1(url);
    const amountMsat = noteDeclaredAmount(url);
    const signature = noteSignature(url);
    if (!k1 || amountMsat === null || !signature) throw new Error('the note lacks its sig param');
    expect(verifyNoteSignature(k1, amountMsat, signature, mint.signingPubkey())).toBe(false);

    // keep the note: the balance is not corrupted by the bad proof
    const sendDialog = page.locator('.q-dialog', { hasText: 'Send a note' });
    await sendDialog.getByRole('button', { name: 'Keep in wallet' }).click();
    await expect(page.locator('.balance-card .text-h2')).toHaveText('50');

    // the carve's outputs stayed unverified, so the wallet refuses to spend
    // from them - a second preparation fails instead of moving bad notes
    await page.getByRole('button', { name: 'Send' }).click();
    const chooser = page.locator('.q-dialog', { hasText: 'Hand someone a note' });
    await chooser.getByRole('button', { name: 'Bearer note' }).click();
    const retry = page.locator('.q-dialog', { hasText: 'Send a note' });
    await retry.getByLabel('Amount (sats)').fill('21');
    await retry.getByRole('button', { name: 'Prepare note' }).click();
    await expect(
      retry.locator('.q-banner', { hasText: 'Not enough spendable balance' }),
    ).toBeVisible();
    await expect(retry.getByText('Tap to reveal')).toHaveCount(0);
    await expect(page.locator('.balance-card .text-h2')).toHaveText('50');
  });
});
