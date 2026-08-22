import type { Page, TestInfo } from '@playwright/test';

import { test, expect } from '../fixtures';
import { createFreshWallet } from '../helpers/wallet';

const MINT_KEY_A = `02${'aa'.repeat(32)}`;
const MINT_KEY_B = `03${'bb'.repeat(32)}`;
const MINT_KEY_C = `02${'cc'.repeat(32)}`;
const VIEWPORT_WIDTHS = [375, 768, 1280] as const;
const CONCURRENT_ADD_ROUNDS = 10;

const mintsList = (page: Page) => page.locator('.q-list', { hasText: 'Your mints' });

const fillMintForm = async (page: Page, server: string, mintPubkey: string): Promise<void> => {
  await page.getByLabel('Server').fill(server);
  await page.getByLabel('Signing key (66 hex characters)').fill(mintPubkey);
};

const addMint = async (page: Page, server: string, mintPubkey: string): Promise<void> => {
  await fillMintForm(page, server, mintPubkey);
  await page.getByRole('button', { name: 'Trust this mint' }).click();
};

const ownerId = async (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const raw = localStorage.getItem('sattle_linking_key');
    if (raw === null) return null;
    const saved: unknown = JSON.parse(raw);
    if (typeof saved !== 'object' || saved === null || !('ownerId' in saved)) return null;
    return typeof saved.ownerId === 'string' ? saved.ownerId : null;
  });

const storedMintServers = async (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const raw = localStorage.getItem('sattle_trusted_mints');
    if (raw === null) return [];
    const registry: unknown = JSON.parse(raw);
    if (
      typeof registry !== 'object' ||
      registry === null ||
      !('mints' in registry) ||
      !Array.isArray(registry.mints)
    ) {
      return [];
    }
    return registry.mints
      .map((mint) =>
        typeof mint === 'object' &&
        mint !== null &&
        'server' in mint &&
        typeof mint.server === 'string'
          ? mint.server
          : '',
      )
      .sort();
  });

const retainFailureEvidence = async (
  testInfo: TestInfo,
  pages: readonly Page[],
  consoleMessages: readonly string[],
): Promise<void> => {
  for (const [index, page] of pages.entries()) {
    if (page.isClosed()) continue;
    const path = testInfo.outputPath(`tab-${index + 1}-failure.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`tab-${index + 1}-failure`, { path, contentType: 'image/png' });
  }
  await testInfo.attach('browser-console', {
    body: consoleMessages.join('\n'),
    contentType: 'text/plain',
  });
};

test.describe('trusted mint tabs', () => {
  test('remote updates converge and concurrent additions survive Web Locks', async ({
    page,
  }, testInfo) => {
    await createFreshWallet(page);
    test.skip(
      !(await page.evaluate(() => 'locks' in navigator)),
      'Web Locks are unavailable, so this browser provides no concurrent-write guarantee.',
    );

    const remote = await page.context().newPage();
    const consoleMessages: string[] = [];
    for (const [name, current] of [
      ['first', page],
      ['second', remote],
    ] as const) {
      current.on('console', (message) => {
        consoleMessages.push(`[${name}] ${message.type()}: ${message.text()}`);
      });
    }

    try {
      await Promise.all([page.goto('/#/settings/mints'), remote.goto('/#/settings/mints')]);
      await expect(mintsList(page).getByText('No mints yet', { exact: false })).toBeVisible();
      await expect(mintsList(remote).getByText('No mints yet', { exact: false })).toBeVisible();

      // A real storage event from the second tab updates the first tab without reload.
      await addMint(remote, 'remote.example', MINT_KEY_A);
      await expect(mintsList(page).getByText('remote.example', { exact: true })).toBeVisible();

      // Repeated UI races from separate pages must all survive Web Locks.
      const expectedServers = ['remote.example'];
      for (let round = 1; round <= CONCURRENT_ADD_ROUNDS; round++) {
        const firstServer = `first-${round}.example`;
        const secondServer = `second-${round}.example`;
        expectedServers.push(firstServer, secondServer);
        await Promise.all([
          fillMintForm(page, firstServer, MINT_KEY_B),
          fillMintForm(remote, secondServer, MINT_KEY_C),
        ]);
        await Promise.all([
          page.getByRole('button', { name: 'Trust this mint' }).click(),
          remote.getByRole('button', { name: 'Trust this mint' }).click(),
        ]);
        await expect.poll(() => storedMintServers(page)).toEqual([...expectedServers].sort());
      }

      for (const width of VIEWPORT_WIDTHS) {
        await Promise.all([
          page.setViewportSize({ width, height: 900 }),
          remote.setViewportSize({ width, height: 900 }),
        ]);
        await expect(mintsList(page).getByText('first-10.example', { exact: true })).toBeVisible();
        await expect(mintsList(page).getByText('second-10.example', { exact: true })).toBeVisible();
        await expect(
          mintsList(remote).getByText('first-10.example', { exact: true }),
        ).toBeVisible();
        await expect(
          mintsList(remote).getByText('second-10.example', { exact: true }),
        ).toBeVisible();
      }
      expect(await storedMintServers(page)).toEqual([...expectedServers].sort());
    } catch (error) {
      await retainFailureEvidence(testInfo, [page, remote], consoleMessages);
      throw error;
    } finally {
      await remote.close();
    }
  });
});

test.describe('wallet ownership', () => {
  test('a stale owner tab locks and cannot recreate trust or NWC state', async ({
    page,
  }, testInfo) => {
    await createFreshWallet(page);
    const oldOwner = await ownerId(page);
    expect(oldOwner).not.toBeNull();

    const stale = await page.context().newPage();
    const consoleMessages: string[] = [];
    for (const [name, current] of [
      ['successor', page],
      ['stale', stale],
    ] as const) {
      current.on('console', (message) => {
        consoleMessages.push(`[${name}] ${message.type()}: ${message.text()}`);
      });
    }

    try {
      await stale.goto('/#/settings/mints');
      await expect(mintsList(stale).getByText('No mints yet', { exact: false })).toBeVisible();

      // The active page forgets owner A, then creates owner B through the rendered onboarding flow.
      await page.evaluate(() => window.__sattleWalletTest.forget());
      await expect(page.getByRole('button', { name: 'Get started' })).toBeVisible();
      await stale.goto('/#/');
      await expect(stale.getByText('Wallet locked')).toBeVisible();

      await page.getByRole('button', { name: 'Get started' }).click();
      await page.getByRole('button', { name: 'Create wallet' }).click();
      await page.locator('.q-checkbox', { hasText: 'I wrote it down' }).click();
      await page.getByRole('button', { name: 'Continue' }).click();
      await expect(page.getByRole('button', { name: 'Receive' })).toBeVisible();

      const successorOwner = await ownerId(page);
      expect(successorOwner).not.toBe(oldOwner);
      for (const width of VIEWPORT_WIDTHS) {
        await stale.setViewportSize({ width, height: 900 });
        await expect(stale.getByText('Wallet locked')).toBeVisible();
      }

      // A stale settings route cannot call owner-bound mutations after invalidation.
      await stale.goto('/#/settings/mints');
      await addMint(stale, 'stale.example', MINT_KEY_A);
      await expect(stale.locator('.q-banner', { hasText: 'Wallet is locked.' })).toBeVisible();
      await stale.goto('/#/settings/nwc');
      await expect(stale.locator('.q-page', { hasText: 'Unlock your wallet first' })).toBeVisible();

      const residue = await page.evaluate(() => ({
        trustedMints: localStorage.getItem('sattle_trusted_mints'),
        nwcConnections: localStorage.getItem('sattle_nwc_connections'),
        nwcEnabled: localStorage.getItem('sattle_nwc_enabled'),
      }));
      expect(residue).toEqual({ trustedMints: null, nwcConnections: null, nwcEnabled: null });
    } catch (error) {
      await retainFailureEvidence(testInfo, [page, stale], consoleMessages);
      throw error;
    } finally {
      await stale.close();
    }
  });
});
