import { bytesToHex } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

import { test, expect } from '../fixtures';

// Wallet lifecycle in the real browser: a LEGACY (ownerless) encrypted wallet
// with ownerless passkey/NWC/trust residue must migrate to the proven owner
// during password unlock - before the NWC service may start - and forgetting
// the wallet must drain/stop that service and remove every wallet-owned key
// before a successor wallet can be created without any of the old residue.
//
// The legacy encrypted record is produced here with the exact same KDF/wrap
// the app uses (keys.ts: PBKDF2-SHA256 210k -> AES-GCM), just without the
// owner marker a current build would stamp.

declare global {
  interface Window {
    __sattleWalletTest: { state: () => string; forget: () => Promise<void> };
  }
}

const PASSWORD = 'correct horse battery staple';
const LINKING_KEY_HEX = '07'.repeat(32);
const OWNER_ID = bytesToHex(secp256k1.getPublicKey(hexToBytesLocal(LINKING_KEY_HEX), true));
const MINT_PUBKEY = '02' + 'aa'.repeat(32);

function hexToBytesLocal(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const PBKDF2_ITERATIONS = 210_000;

const legacyEncryptedRecord = async (
  valueHex: string,
  password: string,
): Promise<{ salt: string; iv: string; ciphertext: string }> => {
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
      new TextEncoder().encode(valueHex),
    ),
  );
  return { salt: bytesToHex(salt), iv: bytesToHex(iv), ciphertext: bytesToHex(ciphertext) };
};

const WALLET_KEYS = [
  'sattle_linking_key',
  'sattle_bearers',
  'sattle_activity',
  'sattle_settings',
  'sattle_passkey_slots',
  'sattle_nwc_connections',
  'sattle_nwc_enabled',
  'sattle_trusted_mints',
  'sattle_biometric_wrap',
] as const;

test.describe('wallet lifecycle', () => {
  test('legacy unlock migrates, forget wipes the owner, successor starts clean', async ({
    page,
  }) => {
    // Given a legacy encrypted wallet (no owner marker) plus ownerless residue
    const record = await legacyEncryptedRecord(LINKING_KEY_HEX, PASSWORD);
    await page.addInitScript(
      ({ storedRecord, mintPubkey }) => {
        localStorage.setItem('sattle_linking_key', JSON.stringify({ enc: true, ...storedRecord }));
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
          JSON.stringify([{ server: 'legacy.example', mintPubkey, addedAt: 1, locked: false }]),
        );
      },
      { storedRecord: record, mintPubkey: MINT_PUBKEY },
    );

    await page.goto('/#/');

    // the unlock screen proves the app boot finished and the dev hooks exist
    await expect(page.getByText('Wallet locked')).toBeVisible();
    await expect
      .poll(async () => page.evaluate(() => typeof window.__sattleNwcTest))
      .toBe('object');

    // no real relay traffic once the migrated enabled state starts the service
    await page.evaluate(() => {
      window.__nwcSubs = [];
      window.__sattleNwcTest.setTransport({
        publish: () => Promise.resolve(),
        subscribe: () => {
          const sub = {
            closed: false,
            close() {
              this.closed = true;
            },
          };
          window.__nwcSubs.push(sub);
          return sub;
        },
      });
    });

    // When the holder proves the wallet by password
    await page.locator('.unlock-card input').fill(PASSWORD);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();

    // Then the wallet unlocks...
    await expect(page.getByRole('button', { name: 'Receive' })).toBeVisible();

    // ...and every legacy namespace was migrated to the proven owner BEFORE
    // the NWC service could start (the subscriptions below only exist because
    // the migrated owner-scoped enabled record read true)
    const migrated = await page.evaluate(() => {
      const field = (storageKey: string, name: string): unknown => {
        const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
        return typeof value === 'object' && value !== null
          ? Object.entries(value).find(([key]) => key === name)?.[1]
          : undefined;
      };
      const fields = (storageKey: string, name: string): unknown[] => {
        const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
        if (!Array.isArray(value)) return [];
        return value.map((entry: unknown) =>
          typeof entry === 'object' && entry !== null
            ? Object.entries(entry).find(([key]) => key === name)?.[1]
            : undefined,
        );
      };
      const mints: unknown = field('sattle_trusted_mints', 'mints');
      return {
        savedKeyOwner: field('sattle_linking_key', 'ownerId'),
        passkeyOwners: fields('sattle_passkey_slots', 'ownerId'),
        nwcEnabledOwner: field('sattle_nwc_enabled', 'ownerId'),
        nwcEnabled: field('sattle_nwc_enabled', 'enabled'),
        nwcConnectionOwners: fields('sattle_nwc_connections', 'ownerId'),
        trustedMintsOwner: field('sattle_trusted_mints', 'ownerId'),
        trustedMintServers: Array.isArray(mints)
          ? mints.map((mint: unknown) =>
              typeof mint === 'object' && mint !== null && 'server' in mint
                ? mint.server
                : undefined,
            )
          : [],
      };
    });
    expect(migrated.savedKeyOwner).toBe(OWNER_ID);
    expect(migrated.passkeyOwners).toEqual([OWNER_ID]);
    expect({ ownerId: migrated.nwcEnabledOwner, enabled: migrated.nwcEnabled }).toEqual({
      ownerId: OWNER_ID,
      enabled: true,
    });
    expect(migrated.nwcConnectionOwners).toEqual([OWNER_ID]);
    expect(migrated.trustedMintsOwner).toBe(OWNER_ID);
    expect(migrated.trustedMintServers).toEqual(['legacy.example']);
    await expect.poll(async () => page.evaluate(() => window.__nwcSubs.length)).toBeGreaterThan(0);

    // When the wallet is forgotten
    await page.evaluate(() => window.__sattleWalletTest.forget());

    // Then the app lands on the no-wallet screen, the service is drained
    // (every subscription closed), and no wallet-owned key remains
    await expect(page.getByRole('button', { name: 'Get started' })).toBeVisible();
    await expect
      .poll(async () => page.evaluate(() => window.__nwcSubs.every((sub) => sub.closed)))
      .toBe(true);
    const remaining = await page.evaluate(
      (keys) => keys.filter((key) => localStorage.getItem(key) !== null),
      [...WALLET_KEYS],
    );
    expect(remaining).toEqual([]);

    // When a successor wallet is created
    await page.getByRole('button', { name: 'Get started' }).click();
    await page.getByRole('button', { name: 'Create wallet' }).click();
    await page.locator('.q-checkbox', { hasText: 'I wrote it down' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('button', { name: 'Receive' })).toBeVisible();

    // Then it is a different owner with zero adopted residue
    const successor = await page.evaluate(() => {
      const saved: unknown = JSON.parse(localStorage.getItem('sattle_linking_key') ?? 'null');
      return {
        ownerId:
          typeof saved === 'object' && saved !== null && 'ownerId' in saved
            ? saved.ownerId
            : undefined,
        residueKeys: [
          'sattle_passkey_slots',
          'sattle_nwc_connections',
          'sattle_nwc_enabled',
          'sattle_trusted_mints',
        ].filter((key) => localStorage.getItem(key) !== null),
      };
    });
    expect(successor.ownerId).not.toBe(OWNER_ID);
    expect(successor.residueKeys).toEqual([]);
  });
});
