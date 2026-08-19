import { test, expect } from '../fixtures';
import { createFreshWallet } from '../helpers/wallet';

// M4 backup & security surfaces. No real WebAuthn: headless Chromium has no
// platform authenticator, so the security page is asserted in its honest
// unsupported state; no real relays either - the nostr tests stop at
// local state (toggle persistence) and input validation.

const VALID_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const readSettings = async (page: import('@playwright/test').Page) =>
  JSON.parse((await page.evaluate(() => localStorage.getItem('sattle_settings'))) ?? '{}');

test.describe('Backup page', () => {
  test('renders all sections and exports a JSON backup file', async ({ page }) => {
    await createFreshWallet(page);

    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Backup' }).click();
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
