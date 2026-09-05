import {
  MINT_KEY,
  OTHER_OWNER_ID,
  PASSWORD,
  encryptedLinkingKeyRecord,
} from './wallet.lifecycle.testHarness';
import { describe, expect, it } from 'vitest';

import { savedKeyExists, savedWalletMaterialExists } from '@/lnurlcash/keys';
import { addTrustedMint } from '@/lnurlcash/trustedMints';
import { useNwcStore } from './nwc';
import { useWalletStore } from './wallet';

describe('hostile file backup owner', () => {
  it('never installs or namespaces trust from a file-carried legacy key', async () => {
    // Given a fresh device and an encrypted backup whose valid owner claim is foreign
    const wallet = useWalletStore();
    useNwcStore();
    const result = await wallet.restoreFromBackup({
      type: 'sattle-backup',
      version: 2,
      createdAt: 1,
      ownerId: OTHER_OWNER_ID,
      linkingKey: { ...(await encryptedLinkingKeyRecord()), ownerId: OTHER_OWNER_ID },
      bearers: [],
      nextByHost: {},
      trustedMints: [
        {
          server: 'file-mint.example',
          mintPubkey: MINT_KEY,
          addedAt: 1,
          locked: true,
          pendingMintPubkey: '03' + 'bb'.repeat(32),
        },
      ],
    });

    // Then the merge reports what the file carried, but the v2 lifecycle
    // cannot activate a linking-key-only record (the cash root is
    // unrecoverable from it): the residue is removed instead of leaving a
    // half-installed locked wallet behind
    expect(result).toMatchObject({ linkingKeyRestored: true, trustedMintsAdded: 0 });
    expect(savedKeyExists()).toBe(false);
    expect(savedWalletMaterialExists()).toBe(false);
    expect(wallet.state).toBe('none');
    expect(localStorage.getItem('sattle_trusted_mints')).toBeNull();

    // And no unlock can ever succeed against the file's claim
    await expect(wallet.unlock(PASSWORD)).rejects.toThrow();
    expect(wallet.state).toBe('none');

    // When the holder installs their own wallet afterward
    await wallet.create(PASSWORD);
    const ownerId = wallet.pubkey;
    if (ownerId === null) throw new Error('Expected an unlocked owner.');

    // Then only the device's own proven wallet can initialize trust
    await expect(
      addTrustedMint('actual-owner.example', '03' + 'cc'.repeat(32), { ownerId }),
    ).resolves.toBe('added');
    expect(JSON.parse(localStorage.getItem('sattle_trusted_mints') ?? 'null')).toEqual(
      expect.objectContaining({ ownerId }),
    );
  });
});
