import { test, expect } from '../fixtures';

test.describe('Navigation', () => {
  test('hamburger opens Settings and the back button returns to the main page', async ({
    page,
  }) => {
    // fresh device: the main page shows the welcome card
    await page.goto('/');
    await expect(page.getByText('Welcome to sattle')).toBeVisible();

    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(page.getByText('Settings', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByText('Welcome to sattle')).toBeVisible();
  });
});
