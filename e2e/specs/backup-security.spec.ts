import { test, expect } from '../fixtures';
import { createFreshWallet } from '../helpers/wallet';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

// M4 backup & security surfaces. No real WebAuthn: headless Chromium has no
// platform authenticator, so the security page is asserted in its honest
// unsupported state; no real relays either - the nostr tests stop at
// local state (toggle persistence) and input validation.

const VALID_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const readSettings = async (page: import('@playwright/test').Page) =>
  JSON.parse((await page.evaluate(() => localStorage.getItem('sattle_settings'))) ?? '{}');

// A v2 encrypted wallet-material record built with the app's own wrap
// (keys.ts/passwordWrap.ts: PBKDF2-SHA256 210k -> AES-GCM), for specs that
// need a saved, locked wallet without driving the onboarding UI.
const PASSWORD = 'correct horse battery staple';
const PBKDF2_ITERATIONS = 210_000;

const encryptedWalletMaterialRecord = async (
  password: string,
): Promise<{
  enc: true;
  salt: string;
  iv: string;
  ciphertext: string;
  materialHash: string;
  ownerId: string;
  version: 2;
}> => {
  const linkingKeyHex = '07'.repeat(32);
  const material = {
    version: 2,
    linkingKeyHex,
    cashRootHex: '08'.repeat(64),
  };
  const serialized = JSON.stringify(material);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      new TextEncoder().encode(serialized),
    ),
  );
  return {
    enc: true,
    salt: bytesToHex(salt),
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(ciphertext),
    materialHash: bytesToHex(sha256(utf8ToBytes(serialized))),
    ownerId: bytesToHex(secp256k1.getPublicKey(hexToBytesLocal(linkingKeyHex), true)),
    version: 2,
  };
};

const hexToBytesLocal = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

test.describe('Backup page', () => {
  test('renders all sections and exports a JSON backup file', async ({ page }) => {
    await createFreshWallet(page);

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Backup', exact: true }).click();
    await expect(page).toHaveURL(/#\/settings\/backup$/);

    // the honest recovery-phrase state: sattle never stores it
    await expect(page.getByText('Recovery phrase', { exact: true })).toBeVisible();
    await expect(page.getByText('never stored anywhere', { exact: false })).toBeVisible();

    // file export: downloads a .json backup
    await expect(page.getByText('Backup file', { exact: true })).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download backup file' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^sattle-backup-.*\.json$/);

    // the nostr section is there, off by default
    await expect(page.getByText('Nostr backup', { exact: true })).toBeVisible();
  });

  test('the nostr backup toggle persists across a reload', async ({ page }) => {
    await createFreshWallet(page);
    await page.goto('/#/settings/backup');

    const toggle = page.locator('.q-toggle[aria-label="Enable nostr backup"]');
    await expect(toggle).toBeVisible();
    await toggle.click();

    // persisted into wallet settings...
    await expect.poll(async () => (await readSettings(page)).nostrBackupEnabled).toBe(true);

    // ...and the expanded section shows the backup address and relay editor
    await expect(page.getByText('Backup address')).toBeVisible();
    await expect(page.getByText('wss://relay.damus.io')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back up now' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restore from nostr' })).toBeVisible();

    await page.reload();
    const toggleAfter = page.locator('.q-toggle[aria-label="Enable nostr backup"]');
    await expect(toggleAfter).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Backup address')).toBeVisible();
  });
});

test.describe('Security page', () => {
  test('shows the honest unsupported state when no passkey authenticator exists', async ({
    page,
  }) => {
    await createFreshWallet(page);

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Security' }).click();
    await expect(page).toHaveURL(/#\/settings\/security$/);

    // headless Chromium has no platform authenticator - the page must say so
    // plainly instead of offering a flow that would only fail
    await expect(page.getByText("Passkeys aren't available here")).toBeVisible();
    await expect(
      page.getByText('Your password unlock keeps working', { exact: false }),
    ).toBeVisible();

    // auto-lock: display-only for now
    await expect(page.getByText('Locks after 5 minutes without activity')).toBeVisible();
  });

  test('lists only passkeys owned by the current wallet', async ({ page }) => {
    // Given a browser with a PRF-capable authenticator probe and an unlocked wallet
    await page.addInitScript(() => {
      Object.defineProperty(window, 'PublicKeyCredential', {
        configurable: true,
        value: {
          isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
          getClientCapabilities: () => Promise.resolve({ 'extension:prf': true }),
        },
      });
    });
    await createFreshWallet(page);
    await page.evaluate(() => {
      const saved: unknown = JSON.parse(localStorage.getItem('sattle_wallet_material_v2') ?? '{}');
      if (
        typeof saved !== 'object' ||
        saved === null ||
        !('ownerId' in saved) ||
        typeof saved.ownerId !== 'string' ||
        !('materialHash' in saved) ||
        typeof saved.materialHash !== 'string'
      ) {
        throw new Error('expected saved wallet owner');
      }
      const wrap = {
        hkdfSalt: '11'.repeat(16),
        iv: '22'.repeat(12),
        materialHash: saved.materialHash,
        wrappedMaterial: '33'.repeat(48),
        createdAt: 1,
      };
      localStorage.setItem(
        'sattle_passkey_slots',
        JSON.stringify([
          {
            ...wrap,
            credentialId: '44'.repeat(16),
            name: 'Current wallet passkey',
            ownerId: saved.ownerId,
            version: 2,
          },
          {
            ...wrap,
            credentialId: '55'.repeat(16),
            name: 'Foreign wallet passkey',
            ownerId: '0256b328b30c8bf5839e24058747879408bdb36241dc9c2e7c619faa12b2920967',
            version: 2,
          },
        ]),
      );
    });

    // When the security management surface reads passkey slots
    await page.goto('/#/settings/security');

    // Then only the current owner's slot is rendered
    await expect(page.getByText('Current wallet passkey')).toBeVisible();
    await expect(page.getByText('Foreign wallet passkey')).toHaveCount(0);
  });

  test('hides passkey-first unlock when no passkey belongs to the saved wallet', async ({
    page,
  }) => {
    // Given an encrypted v2 saved wallet whose only passkey slot belongs to
    // a DIFFERENT owner (a foreign wallet's residue on the same device)
    const record = await encryptedWalletMaterialRecord(PASSWORD);
    await page.addInitScript(
      ({ storedRecord }) => {
        localStorage.setItem('sattle_wallet_material_v2', JSON.stringify(storedRecord));
        localStorage.setItem(
          'sattle_passkey_slots',
          JSON.stringify([
            {
              credentialId: '44'.repeat(16),
              hkdfSalt: '55'.repeat(16),
              iv: '66'.repeat(12),
              materialHash: '77'.repeat(32),
              wrappedMaterial: '88'.repeat(48),
              createdAt: 1,
              ownerId: '0256b328b30c8bf5839e24058747879408bdb36241dc9c2e7c619faa12b2920967',
              version: 2,
            },
          ]),
        );
      },
      { storedRecord: record },
    );

    // When the locked wallet renders
    await page.goto('/');

    // Then passkey-first unlock is unavailable - the one slot on this
    // device is not this wallet's
    await expect(page.getByText('Wallet locked')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unlock with passkey' })).toHaveCount(0);
  });
});

test.describe('Welcome: restore from nostr', () => {
  test('the nostr tab renders and validates the recovery phrase', async ({ page }) => {
    await page.goto('/#/welcome?tab=nostr');

    await expect(page.getByRole('button', { name: 'Nostr backup' })).toBeVisible();
    await expect(page.locator('textarea')).toBeVisible();
    const lookup = page.getByRole('button', { name: 'Look for a backup' });
    await expect(lookup).toBeDisabled();

    // default relays are offered
    await expect(page.getByText('wss://relay.damus.io')).toBeVisible();

    // junk input never enables the lookup
    await page.locator('textarea').fill('not a real seed phrase at all');
    await expect(lookup).toBeDisabled();

    // a valid 12-word phrase does
    await page.locator('textarea').fill(VALID_PHRASE);
    await expect(lookup).toBeEnabled();
  });
});
