import { createPinia, setActivePinia } from 'pinia';
import { buildNoteUrl } from 'lnurlcash-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NwcService, NwcServiceDeps } from '@/lnurlcash/nwc';
import type * as NwcExports from '@/lnurlcash/nwc';
import { stubLocalStorage } from '@/lnurlcash/test-utils';
import type { NewBearer } from '@/lnurlcash/types';
import { useActivityStore } from './activity';

type StartService = (linkingKey: Uint8Array, deps: NwcServiceDeps) => Promise<NwcService>;
const mocks = vi.hoisted(() => ({ startService: vi.fn<StartService>() }));

vi.mock('@/lnurlcash/nwc', async (importOriginal) => ({
  ...(await importOriginal<typeof NwcExports>()),
  startService: mocks.startService,
}));

import { useNwcStore } from './nwc';
import { useWalletStore } from './wallet';

const note = (secret: string): NewBearer => ({
  url: buildNoteUrl('https://mint.example/w', secret.repeat(32), 21_000),
  callback: 'https://mint.example/w/cb',
  amount: 21_000,
  verified: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal('navigator', {});
  stubLocalStorage();
  setActivePinia(createPinia());
  mocks.startService.mockResolvedValue({
    connections: [],
    stop: vi.fn().mockResolvedValue(undefined),
  });
});

describe('NWC store changeset adapter', () => {
  it('commits the complete engine changeset in one bearer write', async () => {
    const storage = stubLocalStorage();
    const wallet = useWalletStore();
    await wallet.create();
    const [existing] = await wallet.addBearers([note('a')], wallet.captureOwnerFence());
    if (!existing) throw new Error('Expected the initial bearer.');
    const nwc = useNwcStore();
    await nwc.setEnabled(true);
    const start = mocks.startService.mock.calls.at(-1);
    if (!start) throw new Error('Expected the NWC service to start.');
    const writes = vi.spyOn(storage, 'setItem');

    await start[1].applyChangeset(
      { add: [note('b')], markSpent: [existing.id] },
      {
        record: {
          version: 1,
          ownerId: wallet.pubkey ?? '',
          clientPubkey: '11'.repeat(32),
          relays: ['wss://relay.example'],
          budget: { maxMsat: 100_000, periodMs: 60_000 },
          spent: { periodStart: 0, msat: 0 },
          createdAt: 1,
        },
        walletServicePubkey: '22'.repeat(32),
      },
      'pay_invoice',
      start[1].assertCurrentOwner,
    );

    expect(writes.mock.calls.filter(([key]) => key === 'sattle_bearers')).toHaveLength(1);
    expect(wallet.bearers).toHaveLength(2);
    expect(wallet.bearers.find(({ id }) => id === existing.id)?.spent).toBe(true);
  });

  it('surfaces activity durability failure without rolling back committed funds', async () => {
    const storage = stubLocalStorage();
    const wallet = useWalletStore();
    await wallet.create();
    const [existing] = await wallet.addBearers([note('a')], wallet.captureOwnerFence());
    if (!existing) throw new Error('Expected the initial bearer.');
    const nwc = useNwcStore();
    await nwc.setEnabled(true);
    const start = mocks.startService.mock.calls.at(-1);
    if (!start) throw new Error('Expected the NWC service to start.');
    const originalSetItem = storage.setItem;
    storage.setItem = (key, value): void => {
      if (key === 'sattle_activity') throw new Error('activity storage unavailable');
      originalSetItem(key, value);
    };

    await start[1].applyChangeset(
      { add: [], markSpent: [existing.id] },
      {
        record: {
          version: 1,
          ownerId: wallet.pubkey ?? '',
          clientPubkey: '11'.repeat(32),
          relays: ['wss://relay.example'],
          budget: { maxMsat: 100_000, periodMs: 60_000 },
          spent: { periodStart: 0, msat: 0 },
          createdAt: 1,
        },
        walletServicePubkey: '22'.repeat(32),
      },
      'pay_invoice',
      start[1].assertCurrentOwner,
    );

    expect(wallet.bearers.find(({ id }) => id === existing.id)?.spent).toBe(true);
    expect(useActivityStore().events).toEqual([]);
    expect(nwc.lastError).toMatch(/activity history.*do not retry/i);
  });
});
