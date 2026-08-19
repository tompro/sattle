import type { Page } from '@playwright/test';

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
