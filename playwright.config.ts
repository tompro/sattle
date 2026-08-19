import { defineConfig, devices } from '@playwright/test';
import { execSync } from 'child_process';

// no playwright-bundled chrome on this machine - use the system chromium
// (override with CHROMIUM_PATH when it lives elsewhere)
const findSystemChromium = (): string | undefined => {
  try {
    return execSync('command -v chromium').toString().trim() || undefined;
  } catch {
    return undefined;
  }
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: 'html',

  use: {
    baseURL: 'http://localhost:9333',
    trace: 'on-first-retry',
    serviceWorkers: 'block',
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || findSystemChromium(),
    },
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], serviceWorkers: 'block' },
    },
  ],

  webServer: {
    command: 'npx quasar dev -m spa --port 9333',
    url: 'http://localhost:9333',
    // quasar dev needs ~15-25s before vite starts answering
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
