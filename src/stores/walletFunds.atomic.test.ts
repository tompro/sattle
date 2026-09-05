import { createPinia, setActivePinia } from 'pinia';
import { buildNoteUrl, cashNodeFromHex, deriveCashRoot, deriveCashSecret } from 'lnurlcash-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveBearerAesKey } from '@/lnurlcash/keys';
import { loadBearers, readFundsDocument } from '@/lnurlcash/storage';
import { FUNDS_STORAGE_KEY } from '@/lnurlcash/storage/bearers';
import { StorageLocksUnavailableError } from '@/lnurlcash/storageLock';
import { stubLocalStorage } from '@/lnurlcash/test-utils';
import type { Bearer, NewBearer } from '@/lnurlcash/types';
import { useWalletStore } from './wallet';

const CASH_ROOT = deriveCashRoot(new Uint8Array(64).fill(1));

// a present-but-non-serializing LockManager fake: walletFunds serializes its
// own mutations, so single-store tests only need locks to EXIST
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
  stubPassthroughLocks();
  stubLocalStorage();
  setActivePinia(createPinia());
});

describe('wallet multi-bearer durability', () => {
  it('keeps both concurrent additions in reactive and persisted state', async () => {
    const wallet = useWalletStore();
    await wallet.create();
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let releaseFirst: (() => void) | undefined;
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let encryptions = 0;
    vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (algorithm, key, data) => {
      encryptions += 1;
      if (encryptions === 1) {
        firstStarted?.();
        await firstPaused;
      }
      return encrypt(algorithm, key, data);
    });

    const first = wallet.addBearers([note('a')], wallet.captureOwnerFence());
    await firstEntered;
    const second = wallet.addBearers([note('b')], wallet.captureOwnerFence());
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(wallet.bearers).toHaveLength(2);
    const key = await deriveBearerAesKey(wallet.requireLinkingKey());
    expect(await loadBearers(key)).toHaveLength(2);
  });

  it('adds two bearers with one established changeset write', async () => {
    const storage = stubLocalStorage();
    const wallet = useWalletStore();
    await wallet.create();
    const writes = vi.spyOn(storage, 'setItem');

    await wallet.addBearers([note('a'), note('b')], wallet.captureOwnerFence());

    expect(writes.mock.calls.filter(([key]) => key === FUNDS_STORAGE_KEY)).toHaveLength(1);
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

    expect(writes.mock.calls.filter(([key]) => key === FUNDS_STORAGE_KEY)).toHaveLength(1);
    expect(wallet.bearers).toHaveLength(3);
  });
});

describe('wallet BIP-32 counter allocation', () => {
  it('reserves a range, derives its secrets, and stages the journal record in one write', async () => {
    const storage = stubLocalStorage();
    const wallet = useWalletStore();
    await wallet.create();
    const revisionBefore = wallet.fundsRevision;
    const writes = vi.spyOn(storage, 'setItem');

    const allocated = await wallet.allocateCashSecrets(
      CASH_ROOT,
      'mint.example',
      3,
      wallet.captureOwnerFence(),
    );

    expect(writes.mock.calls.filter(([key]) => key === FUNDS_STORAGE_KEY)).toHaveLength(1);
    expect(allocated.host).toBe('mint.example');
    expect(allocated.start).toBe(0);
    expect(allocated.secrets).toEqual([
      deriveCashSecret(CASH_ROOT, 'mint.example', 0),
      deriveCashSecret(CASH_ROOT, 'mint.example', 1),
      deriveCashSecret(CASH_ROOT, 'mint.example', 2),
    ]);
    const doc = readFundsDocument();
    expect(doc.nextByHost).toEqual({ 'mint.example': 3 });
    expect(doc.pending).toHaveLength(1);
    expect(doc.pending[0]?.id).toBe(allocated.pendingId);
    expect(doc.pending[0]?.kind).toBe('cash-allocation');
    // counter-only commits are observable to the nostr-backup scheduler
    expect(wallet.fundsRevision).toBeGreaterThan(revisionBefore);
    // the staged secrets never touch disk in plaintext
    const raw = storage.getItem(FUNDS_STORAGE_KEY) ?? '';
    for (const secret of allocated.secrets) expect(raw).not.toContain(secret);
  });

  it('never hands out the same index twice across sequential reservations', async () => {
    const wallet = useWalletStore();
    await wallet.create();
    const fence = wallet.captureOwnerFence();

    const first = await wallet.allocateCashSecrets(CASH_ROOT, 'mint.example', 2, fence);
    const second = await wallet.allocateCashSecrets(CASH_ROOT, 'mint.example', 2, fence);
    const otherHost = await wallet.allocateCashSecrets(CASH_ROOT, 'other.example:9735', 1, fence);

    expect(first.start).toBe(0);
    expect(second.start).toBe(2);
    expect(second.secrets[0]).toBe(deriveCashSecret(CASH_ROOT, 'mint.example', 2));
    // a different canonical host (port included) has its own counter
    expect(otherHost.start).toBe(0);
    expect(readFundsDocument().nextByHost).toEqual({
      'mint.example': 4,
      'other.example:9735': 1,
    });
  });

  it('burns no index and writes nothing when the staging encryption fails', async () => {
    const wallet = useWalletStore();
    await wallet.create();
    const before = readFundsDocument().revision;
    // the reservation performs exactly one encryption (the staged payload) -
    // reject them all
    vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValue(new Error('crypto subsystem died'));

    await expect(
      wallet.allocateCashSecrets(CASH_ROOT, 'mint.example', 2, wallet.captureOwnerFence()),
    ).rejects.toThrow('crypto subsystem died');

    const doc = readFundsDocument();
    expect(doc.nextByHost).toEqual({});
    expect(doc.pending).toEqual([]);
    expect(doc.revision).toBe(before);
  });

  it('rejects the allocation before derivation when Web Locks are unavailable', async () => {
    const wallet = useWalletStore();
    await wallet.create();
    vi.stubGlobal('navigator', {});
    const encrypt = vi.spyOn(crypto.subtle, 'encrypt');

    await expect(
      wallet.allocateCashSecrets(CASH_ROOT, 'mint.example', 1, wallet.captureOwnerFence()),
    ).rejects.toBeInstanceOf(StorageLocksUnavailableError);

    expect(encrypt).not.toHaveBeenCalled();
    expect(readFundsDocument().nextByHost).toEqual({});
  });

  it('serves the operation-facing allocation from the unlocked wallet material', async () => {
    const wallet = useWalletStore();
    await wallet.create();
    const root = cashNodeFromHex(wallet.requireWalletMaterial().cashRootHex);

    const secrets = await wallet.allocateOutputSecrets(
      'mint.example',
      2,
      wallet.captureOwnerFence(),
    );

    expect(secrets).toEqual([
      deriveCashSecret(root, 'mint.example', 0),
      deriveCashSecret(root, 'mint.example', 1),
    ]);
    expect(readFundsDocument().nextByHost).toEqual({ 'mint.example': 2 });
    expect(readFundsDocument().pending).toHaveLength(1);
  });
});
