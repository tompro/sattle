import { createPinia, setActivePinia } from 'pinia';
import { buildNoteUrl } from 'lnurlcash-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveBearerAesKey } from '@/lnurlcash/keys';
import { loadBearers } from '@/lnurlcash/storage';
import { stubLocalStorage } from '@/lnurlcash/test-utils';
import type { NewBearer } from '@/lnurlcash/types';
import { TrustedMintPostCommitError, useWalletStore } from './wallet';
import { useMintsStore } from './mints';

const MINT_PUBKEY = '02' + 'aa'.repeat(32);
const NOTE: NewBearer = {
  url: buildNoteUrl('https://mint.example/w', 'bb'.repeat(32), 21_000),
  callback: 'https://mint.example/w/cb',
  amount: 21_000,
  verified: true,
  mintPubkey: MINT_PUBKEY,
};

type LockRequest = {
  readonly callback: () => unknown;
  readonly resolve: (value: unknown) => void;
};

class DeferredLocks {
  readonly requests: LockRequest[] = [];

  readonly request = (_name: string, callback: () => unknown): Promise<unknown> =>
    new Promise((resolve) => {
      this.requests.push({ callback, resolve });
    });

  async releaseNext(): Promise<void> {
    const request = this.requests.shift();
    if (!request) throw new Error('Expected a queued lock request.');
    request.resolve(await request.callback());
  }
}

beforeEach(() => {
  vi.unstubAllGlobals();
  stubLocalStorage();
  setActivePinia(createPinia());
});

describe('bearer commit trust side effect', () => {
  it('commits a combined addition and spent marker in one bearer write', async () => {
    vi.stubGlobal('navigator', {});
    const storage = stubLocalStorage();
    const wallet = useWalletStore();
    await wallet.create();
    const ownerFence = wallet.captureOwnerFence();
    const [existing] = await wallet.addBearers([{ ...NOTE, mintPubkey: undefined }], ownerFence);
    if (!existing) throw new Error('Expected the initial bearer.');
    const writes = vi.spyOn(storage, 'setItem');
    const applyChangeset = Reflect.get(wallet, 'applyChangeset');
    if (typeof applyChangeset !== 'function') {
      throw new TypeError('Expected the wallet to expose atomic changeset application.');
    }

    await Reflect.apply(applyChangeset, wallet, [
      { add: [{ ...NOTE, mintPubkey: undefined }], markSpent: [existing.id] },
      ownerFence,
    ]);

    expect(writes.mock.calls.filter(([key]) => key === 'sattle_bearers')).toHaveLength(1);
    expect(wallet.bearers).toHaveLength(2);
    expect(wallet.bearers.find(({ id }) => id === existing.id)?.spent).toBe(true);
  });

  it('keeps an atomic changeset committed when trust convergence fails afterward', async () => {
    vi.stubGlobal('navigator', {});
    const storage = stubLocalStorage();
    const wallet = useWalletStore();
    await wallet.create();
    const ownerFence = wallet.captureOwnerFence();
    const [existing] = await wallet.addBearers([{ ...NOTE, mintPubkey: undefined }], ownerFence);
    if (!existing) throw new Error('Expected the initial bearer.');
    const originalSetItem = storage.setItem;
    storage.setItem = (key, value) => {
      if (key === 'sattle_trusted_mints') throw new Error('trust storage unavailable');
      originalSetItem(key, value);
    };

    await expect(
      wallet.applyChangeset({ add: [NOTE], markSpent: [existing.id] }, ownerFence),
    ).rejects.toBeInstanceOf(TrustedMintPostCommitError);

    expect(wallet.bearers).toHaveLength(2);
    expect(wallet.bearers.find(({ id }) => id === existing.id)?.spent).toBe(true);
    const key = await deriveBearerAesKey(wallet.requireLinkingKey());
    const persisted = await loadBearers(key);
    expect(persisted).toHaveLength(2);
    expect(persisted.find(({ id }) => id === existing.id)?.spent).toBe(true);
  });

  it('waits for trust convergence after the bearer is committed', async () => {
    const wallet = useWalletStore();
    await wallet.create();
    const ownerFence = wallet.captureOwnerFence();
    const locks = new DeferredLocks();
    vi.stubGlobal('navigator', { locks });

    let settled = false;
    const adding = wallet.addBearers([NOTE], ownerFence).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(locks.requests).toHaveLength(1));
    await locks.releaseNext();
    await vi.waitFor(() => expect(locks.requests).toHaveLength(1));

    expect(wallet.bearers).toHaveLength(1);
    expect(settled).toBe(false);
    await locks.releaseNext();

    expect(await adding).toHaveLength(1);
  });

  it('reports trust failure as post-commit while preserving durable funds', async () => {
    vi.stubGlobal('navigator', {});
    const storage = stubLocalStorage();
    const wallet = useWalletStore();
    await wallet.create();
    const ownerFence = wallet.captureOwnerFence();
    const originalSetItem = storage.setItem;
    storage.setItem = (key, value) => {
      if (key === 'sattle_trusted_mints') {
        throw new Error('trust storage unavailable');
      }
      originalSetItem(key, value);
    };

    const adding = wallet.addBearers([NOTE], ownerFence);

    await expect(adding).rejects.toMatchObject({
      name: 'TrustedMintPostCommitError',
      fundsCommitted: true,
      message: expect.stringMatching(/saved|committed/i),
    });
    await expect(adding).rejects.toBeInstanceOf(TrustedMintPostCommitError);
    expect(wallet.bearers).toHaveLength(1);
    expect(wallet.auxiliaryError).toMatch(/receive succeeded.*do not retry/i);
    const key = await deriveBearerAesKey(wallet.requireLinkingKey());
    expect(await loadBearers(key)).toHaveLength(1);
  });
});

describe('owner-bound trusted-mint reads', () => {
  it('uses only the unlocked wallet owner and fails closed while locked', async () => {
    const wallet = useWalletStore();
    const mints = useMintsStore();

    expect(mints.isTrusted('mint.example')).toBe(false);
    expect(mints.trustedPubkey('mint.example')).toBeNull();

    await wallet.create('password');
    await mints.trust('mint.example', MINT_PUBKEY);
    expect(mints.isTrusted('mint.example')).toBe(true);
    expect(mints.trustedPubkey('mint.example')).toBe(MINT_PUBKEY);

    await wallet.lock();
    expect(mints.isTrusted('mint.example')).toBe(false);
    expect(mints.trustedPubkey('mint.example')).toBeNull();

    await wallet.unlock('password');
    expect(mints.isTrusted('mint.example')).toBe(true);
    expect(mints.trustedPubkey('mint.example')).toBe(MINT_PUBKEY);
  });
});
