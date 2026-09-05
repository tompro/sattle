import { createPinia, setActivePinia } from 'pinia';
import { buildNoteUrl } from 'lnurlcash-kit';
import { createMockMint } from 'lnurlcash-conformance/mock-mint';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubLocalStorage } from '@/lnurlcash/test-utils';
import type { NewBearer } from '@/lnurlcash/types';
import { useWalletStore } from './wallet';

type Mint = Awaited<ReturnType<typeof createMockMint>>;

const mints: Mint[] = [];

const mint = async (): Promise<Mint> => {
  const instance = await createMockMint();
  mints.push(instance);
  return instance;
};

const stagedNote = (
  instance: Mint,
  secret: string,
  sourceBearerId?: string,
  sourceRecoverySecret?: string,
): NewBearer => ({
  url: buildNoteUrl(`${instance.url}/w`, secret, 21_000),
  callback: '',
  amount: 0,
  verified: false,
  pendingMint: sourceBearerId ? { sourceBearerId, sourceRecoverySecret } : {},
});

const liveNote = (instance: Mint, secret: string): NewBearer => ({
  url: buildNoteUrl(`${instance.url}/w`, secret, 21_000),
  callback: `${instance.url}/w/cb`,
  amount: 21_000,
  verified: true,
});

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

afterEach(async () => {
  await Promise.all(mints.splice(0).map((instance) => instance.close()));
});

describe('pending mint recovery', () => {
  it('keeps an unpaid staged output at zero value', async () => {
    const instance = await mint();
    const wallet = useWalletStore();
    await wallet.create();
    const [staged] = await wallet.addBearers(
      [stagedNote(instance, 'a'.repeat(64))],
      wallet.captureOwnerFence(),
    );
    if (!staged) throw new Error('Expected a staged bearer.');

    await wallet.recoverPendingMints(wallet.captureOwnerFence());

    expect(wallet.bearers).toEqual([staged]);
    expect(wallet.balanceMsat).toBe(0);
  });

  it('retires an unminted NWC output after its safe settlement window', async () => {
    const instance = await mint();
    const wallet = useWalletStore();
    await wallet.create();
    const note = stagedNote(instance, '7'.repeat(64));
    const [staged] = await wallet.addBearers(
      [{ ...note, pendingMint: { retireAfter: Math.floor(Date.now() / 1000) - 1 } }],
      wallet.captureOwnerFence(),
    );
    if (!staged) throw new Error('Expected a staged bearer.');

    await wallet.recoverPendingMints(wallet.captureOwnerFence());

    expect(wallet.bearers.some((bearer) => bearer.id === staged.id)).toBe(false);
  });

  it('finalizes a paid stage under the same id and spends its transfer source atomically', async () => {
    const storage = stubLocalStorage();
    const instance = await mint();
    const secret = 'b'.repeat(64);
    const wallet = useWalletStore();
    await wallet.create();
    const [source] = await wallet.addBearers(
      [liveNote(instance, 'c'.repeat(64))],
      wallet.captureOwnerFence(),
    );
    if (!source) throw new Error('Expected a source bearer.');
    const [staged] = await wallet.addBearers(
      [stagedNote(instance, secret, source.id)],
      wallet.captureOwnerFence(),
    );
    if (!staged) throw new Error('Expected a staged bearer.');
    instance.state.creditNote(secret, 21_000);
    const writes = vi.spyOn(storage, 'setItem');

    await wallet.recoverPendingMints(wallet.captureOwnerFence());

    expect(writes.mock.calls.filter(([key]) => key === 'sattle_funds_v2')).toHaveLength(1);
    expect(wallet.bearers.find((bearer) => bearer.id === source.id)?.spent).toBe(true);
    expect(wallet.bearers.find((bearer) => bearer.id === staged.id)).toMatchObject({
      amount: 21_000,
      callback: `${instance.url}/w/cb`,
      verified: true,
      pendingMint: undefined,
    });
    expect(wallet.balanceMsat).toBe(21_000);

    await wallet.recoverPendingMints(wallet.captureOwnerFence());
    expect(wallet.balanceMsat).toBe(21_000);
  });

  it('rejects finalization when the staged record is missing', async () => {
    const instance = await mint();
    const wallet = useWalletStore();
    await wallet.create();

    await expect(
      wallet.finalizeStagedMintOutput(
        'missing',
        liveNote(instance, 'd'.repeat(64)),
        wallet.captureOwnerFence(),
      ),
    ).rejects.toThrow('record no longer exists');
  });

  it('reserves a transfer source in the same write that links its staged output', async () => {
    const storage = stubLocalStorage();
    const instance = await mint();
    const wallet = useWalletStore();
    await wallet.create();
    const [source] = await wallet.addBearers(
      [liveNote(instance, 'e'.repeat(64))],
      wallet.captureOwnerFence(),
    );
    const [staged] = await wallet.addBearers(
      [stagedNote(instance, 'f'.repeat(64))],
      wallet.captureOwnerFence(),
    );
    if (!source || !staged) throw new Error('Expected source and staged bearers.');
    const writes = vi.spyOn(storage, 'setItem');

    const recoverySecret = '2'.repeat(64);
    await wallet.reserveStagedMintSource(
      staged.id,
      source.id,
      recoverySecret,
      wallet.captureOwnerFence(),
    );

    expect(writes.mock.calls.filter(([key]) => key === 'sattle_funds_v2')).toHaveLength(1);
    expect(wallet.bearers.find((bearer) => bearer.id === source.id)?.spent).toBe(true);
    expect(wallet.bearers.find((bearer) => bearer.id === staged.id)?.pendingMint).toEqual({
      sourceBearerId: source.id,
      sourceRecoverySecret: recoverySecret,
    });
  });

  it('rejects a second reservation of the same source', async () => {
    const instance = await mint();
    const wallet = useWalletStore();
    await wallet.create();
    const [source] = await wallet.addBearers(
      [liveNote(instance, '3'.repeat(64))],
      wallet.captureOwnerFence(),
    );
    const [first, second] = await wallet.addBearers(
      [stagedNote(instance, '4'.repeat(64)), stagedNote(instance, '5'.repeat(64))],
      wallet.captureOwnerFence(),
    );
    if (!source || !first || !second) throw new Error('Expected source and staged bearers.');
    await wallet.reserveStagedMintSource(
      first.id,
      source.id,
      '6'.repeat(64),
      wallet.captureOwnerFence(),
    );

    await expect(
      wallet.reserveStagedMintSource(
        second.id,
        source.id,
        '7'.repeat(64),
        wallet.captureOwnerFence(),
      ),
    ).rejects.toThrow(/already reserved/i);
  });

  it('re-secures a live linked source after a crash before melt', async () => {
    const instance = await mint();
    const wallet = useWalletStore();
    await wallet.create();
    const sourceSecret = '8'.repeat(64);
    const recoverySecret = '9'.repeat(64);
    instance.state.creditNote(sourceSecret, 21_000);
    const [source] = await wallet.addBearers(
      [liveNote(instance, sourceSecret)],
      wallet.captureOwnerFence(),
    );
    const [staged] = await wallet.addBearers(
      [stagedNote(instance, 'a'.repeat(64))],
      wallet.captureOwnerFence(),
    );
    if (!source || !staged) throw new Error('Expected source and staged bearers.');
    await wallet.reserveStagedMintSource(
      staged.id,
      source.id,
      recoverySecret,
      wallet.captureOwnerFence(),
    );

    await wallet.recoverPendingMints(wallet.captureOwnerFence());

    expect(wallet.bearers.some((bearer) => bearer.id === staged.id)).toBe(false);
    expect(wallet.bearers.find((bearer) => bearer.url.includes(recoverySecret))).toMatchObject({
      amount: 21_000,
      verified: true,
    });
    expect(wallet.balanceMsat).toBe(21_000);
    expect(instance.state.noteState(sourceSecret)).toBe('burned');
    expect(instance.state.noteState(recoverySecret)).toBe('outstanding');
  });

  it('adopts the journaled source secret after a recovery rotate landed before a crash', async () => {
    const instance = await mint();
    const wallet = useWalletStore();
    await wallet.create();
    const sourceSecret = 'd'.repeat(64);
    const recoverySecret = 'e'.repeat(64);
    instance.state.creditNote(recoverySecret, 21_000);
    const [source] = await wallet.addBearers(
      [liveNote(instance, sourceSecret)],
      wallet.captureOwnerFence(),
    );
    const [staged] = await wallet.addBearers(
      [stagedNote(instance, 'f'.repeat(64), source?.id, recoverySecret)],
      wallet.captureOwnerFence(),
    );
    if (!source || !staged) throw new Error('Expected source and staged bearers.');
    await wallet.markSpent(source.id, wallet.captureOwnerFence());

    await wallet.recoverPendingMints(wallet.captureOwnerFence());

    expect(wallet.bearers.some((bearer) => bearer.id === staged.id)).toBe(false);
    expect(wallet.bearers.find((bearer) => bearer.url.includes(recoverySecret))).toMatchObject({
      amount: 21_000,
      verified: true,
    });
    expect(wallet.balanceMsat).toBe(21_000);
  });

  it('deduplicates a returned source saved before its transfer journal was removed', async () => {
    const instance = await mint();
    const wallet = useWalletStore();
    await wallet.create();
    const sourceSecret = '1'.repeat(64);
    const recoverySecret = '2'.repeat(64);
    instance.state.creditNote(recoverySecret, 21_000);
    const [source] = await wallet.addBearers(
      [liveNote(instance, sourceSecret)],
      wallet.captureOwnerFence(),
    );
    const [staged] = await wallet.addBearers(
      [stagedNote(instance, '3'.repeat(64), source?.id, recoverySecret)],
      wallet.captureOwnerFence(),
    );
    await wallet.addBearers([liveNote(instance, recoverySecret)], wallet.captureOwnerFence());
    if (!source || !staged) throw new Error('Expected source and staged bearers.');
    await wallet.markSpent(source.id, wallet.captureOwnerFence());

    await wallet.recoverPendingMints(wallet.captureOwnerFence());

    expect(wallet.bearers.some((bearer) => bearer.id === staged.id)).toBe(false);
    expect(wallet.bearers.filter((bearer) => bearer.url.includes(recoverySecret))).toHaveLength(1);
    expect(wallet.balanceMsat).toBe(21_000);
  });

  it('returns a live source even when the staged target cannot be observed', async () => {
    const instance = await mint();
    const wallet = useWalletStore();
    await wallet.create();
    const sourceSecret = '4'.repeat(64);
    const recoverySecret = '5'.repeat(64);
    instance.state.creditNote(sourceSecret, 21_000);
    const [source] = await wallet.addBearers(
      [liveNote(instance, sourceSecret)],
      wallet.captureOwnerFence(),
    );
    if (!source) throw new Error('Expected a source bearer.');
    const [staged] = await wallet.addBearers(
      [
        {
          url: buildNoteUrl('http://127.0.0.1:1/w', '6'.repeat(64), 21_000),
          callback: '',
          amount: 0,
          verified: false,
          pendingMint: { sourceBearerId: source.id, sourceRecoverySecret: recoverySecret },
        },
      ],
      wallet.captureOwnerFence(),
    );
    if (!staged) throw new Error('Expected a staged bearer.');
    await wallet.markSpent(source.id, wallet.captureOwnerFence());

    await wallet.recoverPendingMints(wallet.captureOwnerFence());

    expect(wallet.bearers.some((bearer) => bearer.id === staged.id)).toBe(false);
    expect(wallet.bearers.find((bearer) => bearer.url.includes(recoverySecret))).toMatchObject({
      amount: 21_000,
      verified: true,
    });
    expect(wallet.balanceMsat).toBe(21_000);
  });

  it('ends recovery when the staged target is definitively spent', async () => {
    const instance = await mint();
    const secret = '1'.repeat(64);
    const wallet = useWalletStore();
    await wallet.create();
    const [staged] = await wallet.addBearers(
      [stagedNote(instance, secret)],
      wallet.captureOwnerFence(),
    );
    if (!staged) throw new Error('Expected a staged bearer.');
    instance.state.creditNote(secret, 21_000);
    instance.state.settleMelt(secret);

    await wallet.recoverPendingMints(wallet.captureOwnerFence());

    expect(wallet.bearers.find((bearer) => bearer.id === staged.id)).toMatchObject({
      spent: true,
      pendingMint: undefined,
    });
  });
});
