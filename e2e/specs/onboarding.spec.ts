import { test, expect } from '../fixtures';

test.describe('Onboarding', () => {
  test('creating a wallet lands on the unlocked main screen', async ({ page }) => {
    await page.goto('/#/welcome');

    // "Create new" is the default tab - its create button is right there
    await expect(page.getByRole('button', { name: 'Create new' })).toBeVisible();
    await page.getByRole('button', { name: 'Create wallet' }).click();

    // the recovery phrase is shown exactly once before the wallet opens
    await expect(page.getByText('Your recovery phrase')).toBeVisible();
    await page.locator('.q-checkbox', { hasText: 'I wrote it down' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();

    // unlocked main screen: 0-sats balance card, the three actions, history
    await expect(page).toHaveURL(/#\/$/);
    const balanceCard = page.locator('.balance-card');
    await expect(balanceCard.locator('.text-h2')).toHaveText('0');
    await expect(balanceCard).toContainText('sats');
    await expect(page.getByRole('button', { name: 'Receive' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Scan' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    await expect(page.getByText('History', { exact: true })).toBeVisible();
  });
});
