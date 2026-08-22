import {
  MINT_KEY,
  OTHER_OWNER_ID,
  OWNER_ID,
  PASSWORD,
  encryptedLinkingKeyRecord,
} from './wallet.lifecycle.testHarness';
import { describe, expect, it } from 'vitest';

import { savedKeyOwnerId } from '@/lnurlcash/keys';
import { addTrustedMint, readTrustedMints } from '@/lnurlcash/trustedMints';
import { useNwcStore } from './nwc';
import { useWalletStore } from './wallet';

describe('hostile file backup owner', () => {
  it('drops file trust until the restored encrypted key proves its actual owner', async () => {
    // Given a fresh device and an encrypted backup whose valid owner claim is foreign
    const wallet = useWalletStore();
    useNwcStore();
    const result = await wallet.restoreFromBackup({
      type: 'sattle-backup',
      version: 1,
      createdAt: 1,
      ownerId: OTHER_OWNER_ID,
      linkingKey: { ...(await encryptedLinkingKeyRecord()), ownerId: OTHER_OWNER_ID },
      bearers: [],
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
    const registryBeforeProof: unknown = JSON.parse(
      localStorage.getItem('sattle_trusted_mints') ?? 'null',
    );
    expect(result).toMatchObject({ linkingKeyRestored: true, trustedMintsAdded: 0 });
    expect(savedKeyOwnerId()).toBeNull();
    expect(registryBeforeProof).toBeNull();

    // When password proof activates the restored linking key
    await expect(wallet.unlock(PASSWORD)).resolves.toBeUndefined();

    // Then the file claim left no residue and only the derived owner can initialize trust
    expect(readTrustedMints(OTHER_OWNER_ID)).toEqual([]);
    expect(readTrustedMints(OWNER_ID)).toEqual([]);
    await expect(
      addTrustedMint('actual-owner.example', '03' + 'cc'.repeat(32), { ownerId: OWNER_ID }),
    ).resolves.toBe('added');
    expect(JSON.parse(localStorage.getItem('sattle_trusted_mints') ?? 'null')).toEqual(
      expect.objectContaining({ ownerId: OWNER_ID }),
    );
  });
});
