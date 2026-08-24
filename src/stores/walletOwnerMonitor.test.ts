import { beforeEach, describe, expect, it, vi } from 'vitest';

import { linkingPubKeyHex } from '@/lnurlcash/keys';
import { stubLocalStorage } from '@/lnurlcash/test-utils';
import { startWalletOwnerMonitor } from './walletOwnerMonitor';

const OWNER_ID = linkingPubKeyHex(new Uint8Array(32).fill(7));
const OTHER_OWNER_ID = linkingPubKeyHex(new Uint8Array(32).fill(9));

describe('wallet owner monitor', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    stubLocalStorage();
  });

  it('consumes a background transition rejection after an owner replacement', () => {
    // Given an unlocked stale owner and a transition promise observed by the queue
    const events = new EventTarget();
    vi.stubGlobal('window', events);
    localStorage.setItem(
      'sattle_linking_key',
      JSON.stringify({
        enc: false,
        value: '09'.repeat(32),
        ownerId: OTHER_OWNER_ID,
        version: 1,
      }),
    );
    const transition = Promise.resolve();
    const catchRejection = vi.spyOn(transition, 'catch');
    startWalletOwnerMonitor({
      snapshot: () => ({ token: 1, state: 'unlocked', ownerId: OWNER_ID }),
      deactivate: vi.fn().mockResolvedValue(undefined),
      runTransition: vi.fn().mockReturnValue(transition),
    });

    // When the browser reports that the saved owner changed
    events.dispatchEvent(
      Object.defineProperties(new Event('storage'), {
        key: { value: 'sattle_linking_key' },
      }),
    );

    // Then the fire-and-forget transition has a rejection consumer
    expect(catchRejection).toHaveBeenCalledOnce();
  });
});
