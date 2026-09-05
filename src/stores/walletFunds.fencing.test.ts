import { createPinia, setActivePinia } from 'pinia';
import { buildNoteUrl } from 'lnurlcash-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deriveBearerAesKey,
  deriveWalletMaterial,
  saveWalletMaterial,
} from '@/lnurlcash/keys';
import { loadBearers, readEncryptedBearers, readFundsDocument } from '@/lnurlcash/storage';
import { FUNDS_STORAGE_KEY } from '@/lnurlcash/storage/bearers';
import { WalletOwnerMismatchError } from '@/lnurlcash/storage/currentOwner';
import { StorageLocksUnavailableError } from '@/lnurlcash/storageLock';
import { stubLocalStorage } from '@/lnurlcash/test-utils';
import type { NewBearer } from '@/lnurlcash/types';
import { useWalletStore } from './wallet';

// a full v2 material for the successor owner: real BIP-32 cash root, fixed
// other linking key (same construction as the lifecycle test harness)
const OTHER_MATERIAL = {
  ...deriveWalletMaterial(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  ),
  linkingKeyHex: '09'.repeat(32),
};

// fund commits REQUIRE Web Locks now; tests that don't care about lock
// timing install a present-but-non-serializing fake
const stubPassthroughLocks = (): void => {
  vi.stubGlobal('navigator', {
    locks: { request: (_name: string, fn: () => unknown) => Promise.resolve().then(fn) },
  });
};

const note = (secret: string): NewBearer => ({
  url: buildNoteUrl('https://mint.example/w', secret.repeat(32), 21_000),
  callback: 'https://mint.example/w/cb',
  amount: 21_000,
  verified: true,
});

// a second tab installing its own wallet: the successor lifecycle writes its
// v2 wallet-material record and deletes the legacy linking-key record, so the
// saved-key owner flips to the successor. Deliberately NO storage event is
// dispatched - the fence must not depend on the wakeup arriving first.
const replacePersistedOwner = async (): Promise<void> => {
  localStorage.removeItem('sattle_linking_key');
  await saveWalletMaterial(OTHER_MATERIAL);
};

type LockRequest = {
  readonly callback: () => unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
};

// mirrors BROWSER LockManager semantics: a callback failure rejects the
// request and frees the lock name (Node 24's LockManager wedges instead,
// which is why these tests drive their own fake)
class DeferredLocks {
  readonly requests: LockRequest[] = [];

  readonly request = (_name: string, callback: () => unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      this.requests.push({ callback, resolve, reject });
    });

  async releaseNext(): Promise<void> {
    const request = this.requests.shift();
    if (!request) throw new Error('Expected a queued lock request.');
    try {
      request.resolve(await request.callback());
    } catch (error) {
      request.reject(error instanceof Error ? error : new Error(String(error), { cause: error }));
    }
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  stubLocalStorage();
  setActivePinia(createPinia());
});

describe('stale-owner fencing of fund commits', () => {
  it('fences a changeset commit after a silent owner replacement', async () => {
    // Given an unlocked wallet with one bearer and no pending storage event
    stubPassthroughLocks();
    const wallet = useWalletStore();
    await wallet.create();
    const ownerFence = wallet.captureOwnerFence();
    const [existing] = await wallet.addBearers([note('aa')], ownerFence);
    if (!existing) throw new Error('Expected the initial bearer.');

    // When another tab replaced the wallet and this (still unlocked) tab
    // tries to commit a fund change
    await replacePersistedOwner();
    await expect(
      wallet.applyChangeset({ add: [note('bb')], markSpent: [existing.id] }, ownerFence),
    ).rejects.toBeInstanceOf(WalletOwnerMismatchError);

    // Then nothing moved: not in storage, not in the reactive list
    expect(readEncryptedBearers()).toHaveLength(1);
    expect(wallet.bearers).toHaveLength(1);
    expect(wallet.bearers[0]?.spent).toBeUndefined();
  });

  it('fences a single-record spent mark after a silent owner replacement', async () => {
    // Given an unlocked wallet whose owner was silently replaced
    stubPassthroughLocks();
    const wallet = useWalletStore();
    await wallet.create();
    const ownerFence = wallet.captureOwnerFence();
    const [existing] = await wallet.addBearers([note('aa')], ownerFence);
    if (!existing) throw new Error('Expected the initial bearer.');
    await replacePersistedOwner();

    // When the stale tab marks the note spent
    await expect(wallet.markSpent(existing.id, ownerFence)).rejects.toBeInstanceOf(
      WalletOwnerMismatchError,
    );

    // Then the record is untouched in both worlds
    expect(wallet.bearers[0]?.spent).toBeUndefined();
    const key = await deriveBearerAesKey(wallet.requireLinkingKey());
    expect((await loadBearers(key))[0]?.spent).toBeUndefined();
  });

  it('revalidates the owner inside the commit lock, after encryption', async () => {
    // Given a changeset commit whose storage write is held at the lock
    stubPassthroughLocks();
    const wallet = useWalletStore();
    await wallet.create();
    const ownerFence = wallet.captureOwnerFence();
    const [existing] = await wallet.addBearers([note('aa')], ownerFence);
    if (!existing) throw new Error('Expected the initial bearer.');

    // When the commit passed the entry fence, finished encryption, and is
    // parked at the lock - and only NOW another tab replaces the owner
    const locks = new DeferredLocks();
    vi.stubGlobal('navigator', { locks });
    const committing = wallet.applyChangeset(
      { add: [note('bb')], markSpent: [existing.id] },
      ownerFence,
    );
    await vi.waitFor(() => expect(locks.requests.length).toBeGreaterThan(0));
    await replacePersistedOwner();
    await locks.releaseNext();

    // Then the commit fails closed instead of writing stale-owner ciphertext
    await expect(committing).rejects.toBeInstanceOf(WalletOwnerMismatchError);
    expect(readEncryptedBearers()).toHaveLength(1);
    expect(wallet.bearers).toHaveLength(1);
    expect(wallet.bearers[0]?.spent).toBeUndefined();
  });

  it('rejects a fence captured by an earlier lifecycle of the same owner', async () => {
    // Given an operation accepted before the encrypted wallet locked and
    // unlocked again under the same persisted owner
    stubPassthroughLocks();
    const wallet = useWalletStore();
    await wallet.create('password');
    const [existing] = await wallet.addBearers([note('aa')], wallet.captureOwnerFence());
    if (!existing) throw new Error('Expected the initial bearer.');
    const staleFence = wallet.captureOwnerFence();
    await wallet.lock();
    await wallet.unlock('password');

    // When the old lifecycle tries to commit into the new runtime
    await expect(
      wallet.applyChangeset({ add: [note('bb')], markSpent: [existing.id] }, staleFence),
    ).rejects.toBeInstanceOf(WalletOwnerMismatchError);

    // Then exact owner equality alone cannot authorize the stale operation
    expect(readEncryptedBearers()).toHaveLength(1);
    expect(wallet.bearers).toHaveLength(1);
    expect(wallet.bearers[0]?.spent).toBeUndefined();
  });

  it('revalidates a spent update inside its persistence lock', async () => {
    stubPassthroughLocks();
    const wallet = useWalletStore();
    await wallet.create();
    const [existing] = await wallet.addBearers([note('aa')], wallet.captureOwnerFence());
    if (!existing) throw new Error('Expected the initial bearer.');
    const ownerFence = wallet.captureOwnerFence();
    const locks = new DeferredLocks();
    vi.stubGlobal('navigator', { locks });

    const updating = wallet.markSpent(existing.id, ownerFence);
    await vi.waitFor(() => expect(locks.requests.length).toBeGreaterThan(0));
    await replacePersistedOwner();
    await locks.releaseNext();

    await expect(updating).rejects.toBeInstanceOf(WalletOwnerMismatchError);
    expect(wallet.bearers[0]?.spent).toBeUndefined();
    const key = await deriveBearerAesKey(wallet.requireLinkingKey());
    expect((await loadBearers(key))[0]?.spent).toBeUndefined();
  });

  it('revalidates a deletion inside its persistence lock', async () => {
    stubPassthroughLocks();
    const wallet = useWalletStore();
    await wallet.create();
    const [existing] = await wallet.addBearers([note('aa')], wallet.captureOwnerFence());
    if (!existing) throw new Error('Expected the initial bearer.');
    const ownerFence = wallet.captureOwnerFence();
    const locks = new DeferredLocks();
    vi.stubGlobal('navigator', { locks });

    const removing = wallet.removeNote(existing.id, ownerFence);
    await vi.waitFor(() => expect(locks.requests.length).toBeGreaterThan(0));
    await replacePersistedOwner();
    await locks.releaseNext();

    await expect(removing).rejects.toBeInstanceOf(WalletOwnerMismatchError);
    expect(readEncryptedBearers()).toHaveLength(1);
    expect(wallet.bearers).toHaveLength(1);
  });

  it('refuses a fund commit entirely when Web Locks are unavailable', async () => {
    // Given an unlocked wallet with one bearer, in a browser without Web Locks
    stubPassthroughLocks();
    const wallet = useWalletStore();
    await wallet.create();
    const ownerFence = wallet.captureOwnerFence();
    const [existing] = await wallet.addBearers([note('aa')], ownerFence);
    if (!existing) throw new Error('Expected the initial bearer.');
    const bytesBefore = localStorage.getItem(FUNDS_STORAGE_KEY);

    // When the environment cannot serialize storage access across tabs
    vi.stubGlobal('navigator', {});

    // Then every mutation rejects before derivation, and the document is
    // byte-identical - a no-lock commit could burn a BIP-32 index twice
    await expect(
      wallet.applyChangeset({ add: [note('bb')], markSpent: [existing.id] }, ownerFence),
    ).rejects.toBeInstanceOf(StorageLocksUnavailableError);
    await expect(wallet.markSpent(existing.id, ownerFence)).rejects.toBeInstanceOf(
      StorageLocksUnavailableError,
    );
    await expect(wallet.removeNote(existing.id, ownerFence)).rejects.toBeInstanceOf(
      StorageLocksUnavailableError,
    );
    expect(localStorage.getItem(FUNDS_STORAGE_KEY)).toBe(bytesBefore);
    expect(readFundsDocument().revision).toBe(1);
    expect(wallet.bearers[0]?.spent).toBeUndefined();
  });
});
