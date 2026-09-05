import { beforeEach, describe, expect, it, vi } from 'vitest';

import { linkingPubKeyHex, saveWalletMaterial, walletMaterialHash } from '@/lnurlcash/keys';
import type { WalletMaterialV2 } from '@/lnurlcash/keys';
import { deriveWalletMaterial } from '@/lnurlcash/keys';
import { stubLocalStorage } from '@/lnurlcash/test-utils';
import { bytesToHex } from '@noble/hashes/utils.js';
import { startWalletOwnerMonitor } from './walletOwnerMonitor';

const LINKING_KEY = new Uint8Array(32).fill(7);
const OTHER_LINKING_KEY = new Uint8Array(32).fill(9);
const MATERIAL: WalletMaterialV2 = {
  ...deriveWalletMaterial(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  ),
  linkingKeyHex: bytesToHex(LINKING_KEY),
};
const OTHER_MATERIAL: WalletMaterialV2 = {
  ...MATERIAL,
  linkingKeyHex: bytesToHex(OTHER_LINKING_KEY),
};
const OWNER_ID = linkingPubKeyHex(LINKING_KEY);

describe('wallet owner monitor', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    stubLocalStorage();
  });

  it('consumes a background transition rejection after an owner replacement', async () => {
    // Given an unlocked stale owner and a transition promise observed by the queue
    const events = new EventTarget();
    vi.stubGlobal('window', events);
    await saveWalletMaterial(OTHER_MATERIAL);
    expect(walletMaterialHash(OTHER_MATERIAL)).toBeTruthy();
    const transition = Promise.resolve();
    const catchRejection = vi.spyOn(transition, 'catch');
    startWalletOwnerMonitor({
      snapshot: () => ({ token: 1, state: 'unlocked', ownerId: OWNER_ID }),
      deactivate: vi.fn().mockResolvedValue(undefined),
      runTransition: vi.fn().mockReturnValue(transition),
    });

    // When the browser reports that the saved material changed
    events.dispatchEvent(
      Object.defineProperties(new Event('storage'), {
        key: { value: 'sattle_wallet_material_v2' },
      }),
    );

    // Then the fire-and-forget transition has a rejection consumer
    expect(catchRejection).toHaveBeenCalledOnce();
  });

  it('ignores legacy-key wakeups while the saved v2 owner is intact', async () => {
    // Given an unlocked owner whose v2 record is untouched
    const events = new EventTarget();
    vi.stubGlobal('window', events);
    await saveWalletMaterial(MATERIAL);
    const deactivate = vi.fn().mockResolvedValue(undefined);
    const stop = startWalletOwnerMonitor({
      snapshot: () => ({ token: 1, state: 'unlocked', ownerId: OWNER_ID }),
      deactivate,
      runTransition: vi.fn((transition: () => Promise<void>) => transition()),
    });

    // When a legacy-key storage event arrives (an old tab clearing residue)
    events.dispatchEvent(
      Object.defineProperties(new Event('storage'), {
        key: { value: 'sattle_linking_key' },
      }),
    );
    await Promise.resolve();

    // Then the session stays active: the v2 owner never changed
    expect(deactivate).not.toHaveBeenCalled();
    stop();
  });
});
