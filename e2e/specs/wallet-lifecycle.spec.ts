import { test, expect } from '../fixtures';

// Wallet lifecycle in the real browser: an unsupported LEGACY (alpha)
// install - the linking-key-only record, the pre-v2 bearer store and their
// ownerless residue - is never migrated (the cash root is unrecoverable
// from a linking key), so boot resets the device to the uninstalled state
// before any route can expose it, and a successor wallet starts without
// any of the old residue.

// every namespace the alpha wallet could have touched
const LEGACY_KEYS = [
  'sattle_linking_key',
  'sattle_bearers',
  'sattle_wallet_material_v2',
  'sattle_passkey_slots',
  'sattle_nwc_connections',
  'sattle_nwc_enabled',
  'sattle_trusted_mints',
  'sattle_biometric_wrap',
  'sattle_activity',
  'sattle_settings',
] as const;

test.describe('wallet lifecycle', () => {
  test('a legacy alpha install is reset at boot and the successor starts clean', async ({
    page,
  }) => {
    // Given a legacy encrypted linking-key record plus ownerless residue
    await page.addInitScript(() => {
      localStorage.setItem(
        'sattle_linking_key',
        JSON.stringify({
          enc: true,
          salt: '11'.repeat(16),
          iv: '22'.repeat(12),
          ciphertext: '33'.repeat(48),
        }),
      );
      localStorage.setItem(
        'sattle_bearers',
        JSON.stringify([{ url: 'https://mint.example/note?k1=legacy', amount: 1000 }]),
      );
      localStorage.setItem(
        'sattle_passkey_slots',
        JSON.stringify([
          {
            credentialId: '11'.repeat(16),
            hkdfSalt: '22'.repeat(16),
            iv: '33'.repeat(12),
            wrappedKey: '44'.repeat(48),
            createdAt: 1,
          },
        ]),
      );
      localStorage.setItem(
        'sattle_nwc_connections',
        JSON.stringify([
          {
            clientPubkey: '55'.repeat(32),
            relays: ['wss://relay.example'],
            budget: { maxMsat: 1000, periodMs: 60_000 },
            spent: { periodStart: 0, msat: 0 },
            createdAt: 1,
          },
        ]),
      );
      localStorage.setItem('sattle_nwc_enabled', 'true');
      localStorage.setItem(
        'sattle_trusted_mints',
        JSON.stringify([
          {
            server: 'legacy.example',
            mintPubkey: `02${'aa'.repeat(32)}`,
            addedAt: 1,
            locked: false,
          },
        ]),
      );
    });

    // When the app boots
    await page.goto('/#/');

    // Then the alpha reset landed on the uninstalled state - no unlock
    // surface for a wallet that can never be derived again
    await expect(page.getByRole('button', { name: 'Get started' })).toBeVisible();
    await expect(page.getByText('Wallet locked')).toHaveCount(0);

    // ...and every namespace the alpha wallet could have touched is gone
    const remaining = await page.evaluate(
      (keys) => keys.filter((key) => localStorage.getItem(key) !== null),
      [...LEGACY_KEYS],
    );
    expect(remaining).toEqual([]);

    // When a successor wallet is created
    await page.getByRole('button', { name: 'Get started' }).click();
    await page.getByRole('button', { name: 'Create wallet' }).click();
    await page.locator('.q-checkbox', { hasText: 'I wrote it down' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();

    // Then it unlocks into a working wallet with zero adopted residue
    // (settings/activity are the live app's own namespaces - the residue
    // check covers only the stores a predecessor could have planted)
    await expect(page.getByRole('button', { name: 'Receive' })).toBeVisible();
    await expect(page.locator('.balance-card .text-h2')).toHaveText('0');
    const residue = await page.evaluate(
      (keys) => keys.filter((key) => localStorage.getItem(key) !== null),
      [
        'sattle_linking_key',
        'sattle_bearers',
        'sattle_passkey_slots',
        'sattle_nwc_connections',
        'sattle_nwc_enabled',
        'sattle_trusted_mints',
        'sattle_biometric_wrap',
      ],
    );
    expect(residue).toEqual([]);
  });
});
