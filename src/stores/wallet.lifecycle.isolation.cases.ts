import {
  MINT_KEY,
  OTHER_OWNER_ID,
  PASSWORD,
  installLegacyOwnerlessResidue,
} from './wallet.lifecycle.testHarness';
import { describe, expect, it } from 'vitest';

import { generateSeedPhrase, savedKeyExists } from '@/lnurlcash/keys';
import { readNwcConnections, readNwcEnabled } from '@/lnurlcash/nwc';
import { readPasskeySlots } from '@/lnurlcash/passkeys';
import { addTrustedMint, readTrustedMints } from '@/lnurlcash/trustedMints';
import { useNwcStore } from './nwc';
import { useWalletStore } from './wallet';

describe('foreign wallet isolation', () => {
  it('clears ownerless residue and the old trust tombstone before creating a successor', async () => {
    // Given ownerless legacy authorization plus a prior owner's trust tombstone
    installLegacyOwnerlessResidue();
    localStorage.setItem(
      'sattle_trusted_mints',
      JSON.stringify({ version: 1, ownerId: OTHER_OWNER_ID, mints: [] }),
    );
    const wallet = useWalletStore();
    useNwcStore();

    // When a new wallet is installed
    await wallet.create();

    // Then it starts without residue and can initialize its own trust registry
    expect(wallet.pubkey).not.toBe(OTHER_OWNER_ID);
    expect(readPasskeySlots()).toEqual([]);
    expect(readNwcConnections(wallet.pubkey)).toEqual([]);
    expect(readNwcEnabled(wallet.pubkey)).toBe(false);
    expect(readTrustedMints(wallet.pubkey ?? undefined)).toEqual([]);
    await expect(
      addTrustedMint('successor.example', MINT_KEY, { ownerId: wallet.pubkey ?? '' }),
    ).resolves.toBe('added');
  });

  it('rejects malformed file restore without changing the installed state', async () => {
    // Given an empty installation
    const wallet = useWalletStore();

    // When malformed backup input crosses the serialized restore boundary
    const restoring = wallet.restoreFromBackup({ type: 'not-a-wallet' });

    // Then it fails explicitly and does not install a partial wallet
    await expect(restoring).rejects.toThrow(/valid sattle backup/i);
    expect(wallet.state).toBe('none');
    expect(savedKeyExists()).toBe(false);
  });

  it('tears down the installed owner before a foreign seed restore', async () => {
    // Given an installed wallet with owner-scoped credentials and trust
    const wallet = useWalletStore();
    useNwcStore();
    await wallet.create(PASSWORD);
    const oldOwner = wallet.pubkey;
    if (oldOwner === null) throw new Error('Expected an unlocked owner.');
    localStorage.setItem(
      'sattle_passkey_slots',
      JSON.stringify([
        {
          credentialId: '11'.repeat(16),
          hkdfSalt: '22'.repeat(16),
          iv: '33'.repeat(12),
          wrappedKey: '44'.repeat(48),
          createdAt: 1,
          ownerId: oldOwner,
        },
      ]),
    );
    await addTrustedMint('old.example', MINT_KEY, { ownerId: oldOwner });
    localStorage.setItem(
      'sattle_trusted_mints',
      JSON.stringify({ version: 1, ownerId: OTHER_OWNER_ID, mints: [] }),
    );

    // When a different seed replaces that installation
    await wallet.restoreFromSeed(generateSeedPhrase());

    // Then old credentials are gone and only the successor is active
    expect(wallet.pubkey).not.toBe(oldOwner);
    expect(localStorage.getItem('sattle_passkey_slots')).toBeNull();
    expect(readTrustedMints(oldOwner)).toEqual([]);
    expect(readTrustedMints(wallet.pubkey ?? undefined)).toEqual([]);
  });
});
