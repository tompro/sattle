import { createPinia, setActivePinia } from 'pinia';
import { buildNoteUrl } from 'lnurlcash-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveBearerAesKey } from '@/lnurlcash/keys';
import type { CarveResult } from '@/lnurlcash/ops';
import { loadBearers } from '@/lnurlcash/storage';
import { FUNDS_STORAGE_KEY } from '@/lnurlcash/storage/bearers';
import { stubLocalStorage } from '@/lnurlcash/test-utils';
import type { NewBearer } from '@/lnurlcash/types';
import { commitCarve } from './walletCarveCommit';
import { useWalletStore } from '../stores/wallet';

const note = (secret: string): NewBearer => ({
  url: buildNoteUrl('https://mint.example/w', secret.repeat(32), 21_000),
  callback: 'https://mint.example/w/cb',
  amount: 21_000,
  verified: true,
});

const failOnBearerWrite = (occurrence: number): void => {
  const setItem = localStorage.setItem.bind(localStorage);
  let writes = 0;
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key === FUNDS_STORAGE_KEY) {
      writes += 1;
      if (writes === occurrence) throw new Error('bearer storage unavailable');
    }
    setItem(key, value);
  });
};

// a present-but-non-serializing LockManager fake: walletFunds serializes its
// own mutations, so single-store tests only need locks to EXIST
const stubPassthroughLocks = (): void => {
  vi.stubGlobal('navigator', {
    locks: { request: (_name: string, fn: () => unknown) => Promise.resolve().then(fn) },
  });
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  stubPassthroughLocks();
  stubLocalStorage();
  setActivePinia(createPinia());
});

describe('commitCarve', () => {
  it('commits the carve additions and spent marks in one bearer write', async () => {
    // Given a wallet holding the carve's input note
    const wallet = useWalletStore();
    await wallet.create();
    const ownerFence = wallet.captureOwnerFence();
    const [input] = await wallet.addBearers([note('aa')], ownerFence);
    if (!input) throw new Error('Expected the input bearer.');
    const carve: CarveResult = {
      note: note('bb'),
      change: note('cc'),
      consumed: [input],
    };
    const writes = vi.spyOn(localStorage, 'setItem');

    // When the carve is committed
    const committed = await commitCarve(wallet, carve, {
      ownerFence,
      warn: () => undefined,
    });

    // Then the whole rotation landed as ONE durable write
    expect(writes.mock.calls.filter(([key]) => key === FUNDS_STORAGE_KEY)).toHaveLength(1);
    expect(committed.url).toBe(carve.note.url);
    expect(wallet.bearers).toHaveLength(3);
    expect(wallet.bearers.find((bearer) => bearer.id === input.id)?.spent).toBe(true);
    const key = await deriveBearerAesKey(wallet.requireLinkingKey());
    const persisted = await loadBearers(key);
    expect(persisted).toHaveLength(3);
    expect(persisted.find((bearer) => bearer.id === input.id)?.spent).toBe(true);
  });

  it('survives a failure that would have hit the old split commit second write', async () => {
    // Given a wallet holding the carve's input note, with the second
    // funds-document write poisoned (the old add-then-markSpent split wrote
    // twice; the single-write commit never reaches a second write)
    const wallet = useWalletStore();
    await wallet.create();
    const ownerFence = wallet.captureOwnerFence();
    const [input] = await wallet.addBearers([note('aa')], ownerFence);
    if (!input) throw new Error('Expected the input bearer.');
    failOnBearerWrite(2);
    const carve: CarveResult = {
      note: note('bb'),
      change: note('cc'),
      consumed: [input],
    };

    // When the carve is committed
    const committed = await commitCarve(wallet, carve, {
      ownerFence,
      warn: () => undefined,
    });

    // Then the rotation committed completely: additions tracked, input spent
    expect(committed.url).toBe(carve.note.url);
    expect(wallet.bearers).toHaveLength(3);
    expect(wallet.bearers.find((bearer) => bearer.id === input.id)?.spent).toBe(true);
    const key = await deriveBearerAesKey(wallet.requireLinkingKey());
    const persisted = await loadBearers(key);
    expect(persisted).toHaveLength(3);
    expect(persisted.find((bearer) => bearer.id === input.id)?.spent).toBe(true);
  });

  it('leaves no partial carve behind when the commit write itself fails', async () => {
    // Given bearer storage that fails the very next write
    const wallet = useWalletStore();
    await wallet.create();
    const ownerFence = wallet.captureOwnerFence();
    const [input] = await wallet.addBearers([note('aa')], ownerFence);
    if (!input) throw new Error('Expected the input bearer.');
    failOnBearerWrite(1);

    // When the carve commit fails
    await expect(
      commitCarve(
        wallet,
        { note: note('bb'), change: note('cc'), consumed: [input] },
        { ownerFence, warn: () => undefined },
      ),
    ).rejects.toThrow('bearer storage unavailable');

    // Then nothing moved: not in storage, not in the reactive list
    expect(wallet.bearers).toHaveLength(1);
    expect(wallet.bearers[0]?.spent).toBeUndefined();
    const key = await deriveBearerAesKey(wallet.requireLinkingKey());
    const persisted = await loadBearers(key);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.spent).toBeUndefined();
  });

  it('commits the staged and landed phases of the same output as one record', async () => {
    // Given a wallet holding the carve's input note
    const wallet = useWalletStore();
    await wallet.create();
    const ownerFence = wallet.captureOwnerFence();
    const [input] = await wallet.addBearers([note('aa')], ownerFence);
    if (!input) throw new Error('Expected the input bearer.');
    const context = { ownerFence, warn: () => undefined };

    // When the pre-wire phase stages the outputs (sig-less URLs), then the
    // landed phase re-reports them with the mint's signature in the URL
    await commitCarve(wallet, { note: note('bb'), change: note('cc'), consumed: [] }, context);
    expect(wallet.bearers).toHaveLength(3);
    const stagedNote = note('bb');
    const committed = await commitCarve(
      wallet,
      {
        note: { ...stagedNote, url: `${stagedNote.url}&sig=${'ab'.repeat(64)}`, verified: true },
        consumed: [input],
      },
      context,
    );

    // Then the staged record was refreshed in place: still one record per
    // output, the input retired, no duplicate from the URL difference
    expect(wallet.bearers).toHaveLength(3);
    expect(committed.verified).toBe(true);
    expect(wallet.bearers.find((bearer) => bearer.id === input.id)?.spent).toBe(true);
    expect(wallet.bearers.filter((bearer) => bearer.url.includes('bb'.repeat(32)))).toHaveLength(1);
    const key = await deriveBearerAesKey(wallet.requireLinkingKey());
    expect(await loadBearers(key)).toHaveLength(3);
  });
});
