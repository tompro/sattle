import { test as base, expect } from '@playwright/test';
import { MintMocker } from './helpers/MintMocker';

export const test = base.extend<{ mint: MintMocker }>({
  mint: async ({ page }, use) => {
    const mint = new MintMocker(page);
    await use(mint);
    await page.unrouteAll({ behavior: 'wait' });
  },
});

export { expect };
