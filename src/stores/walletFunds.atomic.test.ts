import { createPinia, setActivePinia } from 'pinia';
import { buildNoteUrl } from 'lnurlcash-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveBearerAesKey } from '@/lnurlcash/keys';
import { loadBearers } from '@/lnurlcash/storage';
import { stubLocalStorage } from '@/lnurlcash/test-utils';
import type { Bearer, NewBearer } from '@/lnurlcash/types';
import { useWalletStore } from './wallet';

const note = (secret: string): NewBearer => ({
  url: buildNoteUrl('https://mint.example/w', secret.repeat(32), 21_000),
  callback: 'https://mint.example/w/cb',
  amount: 21_000,
  verified: true,
});

const rejectSecondEncryption = (): void => {
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  let encryptions = 0;
  vi.spyOn(crypto.subtle, 'encrypt').mockImplementation((algorithm, key, data) => {
    encryptions += 1;
    return encryptions === 2
      ? Promise.reject(new Error('second encryption failed'))
      : encrypt(algorithm, key, data);
  });
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal('navigator', {});
  stubLocalStorage();
  setActivePinia(createPinia());
});

describe('wallet multi-bearer durability', () => {
  it('adds two bearers with one established changeset write', async () => {
    const storage = stubLocalStorage();
    const wallet = useWalletStore();
    await wallet.create();
    const writes = vi.spyOn(storage, 'setItem');

    await wallet.addBearers([note('a'), note('b')], wallet.captureOwnerFence());

    expect(writes.mock.calls.filter(([key]) => key === 'sattle_bearers')).toHaveLength(1);
    expect(wallet.bearers).toHaveLength(2);
  });

  it('persists no partial addition when the second bearer encryption fails', async () => {
    const wallet = useWalletStore();
    await wallet.create();
    rejectSecondEncryption();

    await expect(
      wallet.addBearers([note('a'), note('b')], wallet.captureOwnerFence()),
    ).rejects.toThrow('second encryption failed');

    expect(wallet.bearers).toEqual([]);
    const key = await deriveBearerAesKey(wallet.requireLinkingKey());
    expect(await loadBearers(key)).toEqual([]);
  });

  it('persists no partial external merge when the second encryption fails', async () => {
    const wallet = useWalletStore();
    await wallet.create();
    const [existing] = await wallet.addBearers([note('a')], wallet.captureOwnerFence());
    if (!existing) throw new Error('Expected the initial bearer.');
    const incoming: Bearer[] = [
      {
        id: 'incoming-b',
        ...note('b'),
        createdAt: Date.now() + 1,
        updatedAt: Date.now() + 1,
      },
      {
        id: 'incoming-c',
        ...note('c'),
        createdAt: Date.now() + 2,
        updatedAt: Date.now() + 2,
      },
    ];
    rejectSecondEncryption();

    await expect(wallet.mergeExternalBearers(incoming, wallet.captureOwnerFence())).rejects.toThrow(
      'second encryption failed',
    );

    expect(wallet.bearers).toEqual([existing]);
    const key = await deriveBearerAesKey(wallet.requireLinkingKey());
    expect(await loadBearers(key)).toEqual([existing]);
  });

  it('merges multiple external bearers with one established changeset write', async () => {
    const storage = stubLocalStorage();
    const wallet = useWalletStore();
    await wallet.create();
    await wallet.addBearers([note('a')], wallet.captureOwnerFence());
    const now = Date.now();
    const incoming: Bearer[] = [
      { id: 'incoming-b', ...note('b'), createdAt: now + 1, updatedAt: now + 1 },
      { id: 'incoming-c', ...note('c'), createdAt: now + 2, updatedAt: now + 2 },
    ];
    const writes = vi.spyOn(storage, 'setItem');

    await wallet.mergeExternalBearers(incoming, wallet.captureOwnerFence());

    expect(writes.mock.calls.filter(([key]) => key === 'sattle_bearers')).toHaveLength(1);
    expect(wallet.bearers).toHaveLength(3);
  });
});
