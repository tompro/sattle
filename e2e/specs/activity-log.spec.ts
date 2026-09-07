import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { createFreshWallet, fundMockMintWallet } from '../helpers/wallet';
import type { ActivityKind } from '../../src/lnurlcash/storage/activityLog';

// Settings chrome (version footer, no About entry) and the activity
// history: the home-page preview link and the full log's pagination.

type SeededEvent = { kind: ActivityKind; message: string; createdAt: number };

// Write encrypted activity records straight into localStorage, built with
// the app's own wrap (keys.ts: sha256(linking key + context) -> AES-GCM).
// The activity store only reads the log on unlock, so callers reload after
// seeding.
const seedActivityEvents = async (page: Page, events: SeededEvent[]): Promise<void> => {
  const linkingKeyHex = await page.evaluate(() => {
    const saved: unknown = JSON.parse(localStorage.getItem('sattle_wallet_material_v2') ?? '{}');
    if (
      typeof saved !== 'object' ||
      saved === null ||
      !('enc' in saved) ||
      saved.enc !== false ||
      !('value' in saved) ||
      typeof saved.value !== 'string'
    ) {
      throw new Error('expected a plaintext saved wallet material record');
    }
    const material: unknown = JSON.parse(saved.value);
    if (
      typeof material !== 'object' ||
      material === null ||
      !('linkingKeyHex' in material) ||
      typeof material.linkingKeyHex !== 'string'
    ) {
      throw new Error('expected the saved material to carry its linking key');
    }
    return material.linkingKeyHex;
  });
  const material = sha256(
    new Uint8Array([
      ...hexToBytes(linkingKeyHex),
      ...utf8ToBytes('lnurlcash-bearer-encryption-v1'),
    ]),
  );
  const aesKey = await crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt']);
  const records = [];
  for (const event of events) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        aesKey,
        utf8ToBytes(JSON.stringify(event)),
      ),
    );
    records.push({
      id: bytesToHex(crypto.getRandomValues(new Uint8Array(8))),
      iv: bytesToHex(iv),
      ciphertext: bytesToHex(ciphertext),
    });
  }
  await page.evaluate(
    (json) => localStorage.setItem('sattle_activity', json),
    JSON.stringify(records),
  );
};

test.describe('Settings', () => {
  test('shows the app version and no About entry', async ({ page }) => {
    await createFreshWallet(page);

    await page.goto('/#/settings');
    const settings = page.locator('.q-page');
    await expect(settings.getByText(/^sattle v\d+\.\d+\.\d+/)).toBeVisible();
    await expect(settings.locator('.q-item', { hasText: 'About' })).toHaveCount(0);
    // the advanced entries are live routes now
    await expect(settings.locator('.q-item', { hasText: 'Notes' })).toBeVisible();
    await expect(settings.locator('.q-item', { hasText: 'Activity log' })).toBeVisible();
  });
});

test.describe('Activity history', () => {
  test('the home history preview links to the full activity log', async ({ page, mint }) => {
    await fundMockMintWallet(page, mint, 21_000);

    // the preview sits inside the History expansion on the main page
    const history = page.locator('.q-expansion-item', { hasText: 'History' });
    await history.getByText('History', { exact: true }).click();
    await expect(
      history.locator('.history-list').getByText('Received 21 sats from mint.test.'),
    ).toBeVisible();

    await history.getByRole('button', { name: 'View all activity' }).click();
    await expect(page).toHaveURL(/#\/settings\/activity$/);
    await expect(
      page.locator('.q-page').getByText('Received 21 sats from mint.test.'),
    ).toBeVisible();
  });

  test('paginates the activity log', async ({ page }) => {
    await createFreshWallet(page);
    const base = Date.now();
    const kinds: ActivityKind[] = ['mint', 'receive', 'refresh'];
    await seedActivityEvents(
      page,
      Array.from({ length: 25 }, (_, index) => ({
        kind: kinds[index % kinds.length] ?? 'mint',
        message: `Seeded activity ${String(index).padStart(2, '0')}`,
        createdAt: base - index * 60_000,
      })),
    );

    // the log is decrypted on unlock - reload into the auto-unlock
    await page.reload();
    await page.goto('/#/settings/activity');
    await expect(page.locator('.q-page').getByText('Activity log')).toBeVisible();

    // page 1 shows the 20 newest events
    const rows = page.locator('.q-page .history-list .q-item');
    await expect(rows).toHaveCount(20);
    await expect(rows.first()).toContainText('Seeded activity 00');
    await expect(rows.last()).toContainText('Seeded activity 19');

    const pagination = page.locator('.q-pagination');
    await expect(pagination).toBeVisible();
    await pagination.getByRole('button', { name: '2', exact: true }).click();

    // page 2 shows the remaining five, still newest-first
    await expect(rows).toHaveCount(5);
    await expect(rows.first()).toContainText('Seeded activity 20');
    await expect(rows.last()).toContainText('Seeded activity 24');
  });
});
