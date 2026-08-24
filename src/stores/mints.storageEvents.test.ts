import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { linkingPubKeyHex } from '@/lnurlcash/keys';
import { stubLocalStorage } from '@/lnurlcash/test-utils';
import { useMintsStore } from './mints';
import { useWalletStore } from './wallet';

const LINKING_KEY_HEX = '07'.repeat(32);
const OWNER_ID = linkingPubKeyHex(new Uint8Array(32).fill(7));
const MINT_KEY = '02' + 'aa'.repeat(32);
let testPinia: ReturnType<typeof createPinia>;

const storageEvent = (): Event => {
  const event = new Event('storage');
  Object.defineProperties(event, {
    key: { value: 'sattle_trusted_mints' },
    newValue: { value: 'obsolete' },
  });
  return event;
};

beforeEach(() => {
  vi.unstubAllGlobals();
  stubLocalStorage();
  testPinia = createPinia();
  setActivePinia(testPinia);
});

afterEach(() => disposePinia(testPinia));

describe('mints store storage-event convergence', () => {
  it('refreshes the active owner view from live storage without reload', async () => {
    // Given an unlocked wallet and its mounted mints store
    const events = new EventTarget();
    vi.stubGlobal('window', events);
    localStorage.setItem(
      'sattle_linking_key',
      JSON.stringify({ enc: false, value: LINKING_KEY_HEX, ownerId: OWNER_ID, version: 1 }),
    );
    const wallet = useWalletStore();
    await wallet.init();
    const mints = useMintsStore();

    // When another tab stores a trusted mint before an obsolete event arrives
    localStorage.setItem(
      'sattle_trusted_mints',
      JSON.stringify({
        version: 1,
        ownerId: OWNER_ID,
        mints: [{ server: 'remote.example', mintPubkey: MINT_KEY, addedAt: 1, locked: false }],
      }),
    );
    events.dispatchEvent(storageEvent());

    // Then Pinia renders the active owner's live registry without a reload
    await vi.waitFor(() =>
      expect(mints.mints.map((entry) => entry.server)).toEqual(['remote.example']),
    );
  });
});
