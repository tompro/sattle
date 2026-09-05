import { chromium } from '@playwright/test';
import { execSync } from 'child_process';

// Warms the freshly booted dev server before any test runs. `quasar dev`
// answers HTTP the moment its port is up, but vite still transforms the
// module graph on the first page load - a window in which the first test's
// multi-step onboarding flow can race lazy compilation (observed as the
// create flow never reaching /#/). One full load plus a reload completes
// that work before the suite starts. Uses the same system-chromium
// resolution as the main config (CI falls back to the bundled browser).
const findSystemChromium = (): string | undefined => {
  try {
    return execSync('command -v chromium').toString().trim() || undefined;
  } catch {
    return undefined;
  }
};

const globalSetup = async (): Promise<void> => {
  const executablePath = process.env.CHROMIUM_PATH || findSystemChromium();
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
  });
  try {
    const page = await (await browser.newContext({ baseURL: 'http://localhost:9333' })).newPage();
    await page.goto('/');
    await page
      .getByRole('button', { name: 'Get started' })
      .waitFor({ state: 'visible', timeout: 60_000 });
    await page.reload();
    await page
      .getByRole('button', { name: 'Get started' })
      .waitFor({ state: 'visible', timeout: 60_000 });
  } finally {
    await browser.close();
  }
};

export default globalSetup;
