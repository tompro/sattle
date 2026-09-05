// Backup restore waits for owner-bound trusted-mint convergence before it
// reports success, while retaining the hostile-file merge policy. The v2
// format also projects the BIP-32 counters: backups carry nextByHost,
// restore merges upward-only, and pending journal state never leaves the
// device.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bytesToHex } from '@noble/hashes/utils.js';

import { deriveWalletMaterial, linkingPubKeyHex, saveWalletMaterial } from './keys';
import { applyBackup, buildBackup, parseBackupFile } from './storage';
import { readFundsDocument, writeFundsDocument } from './storage/bearers';
import { addTrustedMint, readTrustedMints } from './trustedMints';
import { requiredValue, stubLocalStorage } from './test-utils';

const LINKING_KEY = new Uint8Array(32).fill(7);
const OWNER_ID = linkingPubKeyHex(LINKING_KEY);
const KEY_A = '02' + 'aa'.repeat(32);
const KEY_B = '03' + 'bb'.repeat(32);
// full v2 material for this harness's fixed linking key (real BIP-32 cash
// root, same construction as the lifecycle test harness)
const MATERIAL = {
  ...deriveWalletMaterial(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  ),
  linkingKeyHex: bytesToHex(LINKING_KEY),
};

type LockRequest = {
  readonly callback: () => unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
};

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
      request.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

const backup = (server: string, mintPubkey: string) => ({
  type: 'sattle-backup' as const,
  version: 2 as const,
  createdAt: 1,
  bearers: [],
  nextByHost: {},
  trustedMints: [
    {
      server,
      mintPubkey,
      addedAt: 1,
      locked: true,
      pendingMintPubkey: KEY_B,
    },
  ],
});

const installProvenOwner = (): Promise<void> => saveWalletMaterial(MATERIAL);

beforeEach(() => {
  vi.unstubAllGlobals();
  stubLocalStorage();
});

describe('owner-bound backup restore', () => {
  it('exports only the active owner trusted-mint registry', async () => {
    await installProvenOwner();
    await addTrustedMint('backup-mint.example', KEY_A, { ownerId: OWNER_ID });

    expect(buildBackup(OWNER_ID).trustedMints).toEqual([
      expect.objectContaining({ server: 'backup-mint.example', mintPubkey: KEY_A }),
    ]);
    expect(buildBackup(OWNER_ID).ownerId).toBe(OWNER_ID);
    expect(buildBackup().trustedMints).toEqual([]);
  });

  it('drops fresh-device mint trust instead of using a valid file owner marker', async () => {
    const result = await applyBackup({
      ...backup('file-mint.example', KEY_A),
      ownerId: OWNER_ID,
    });

    expect(result.trustedMintsAdded).toBe(0);
    expect(readTrustedMints(OWNER_ID)).toEqual([]);
    expect(localStorage.getItem('sattle_trusted_mints')).toBeNull();
  });

  it('does not attach file mints to a malformed owner marker', async () => {
    const result = await applyBackup({
      ...backup('file-mint.example', KEY_A),
      ownerId: 'malformed-owner',
    });

    expect(result.trustedMintsAdded).toBe(0);
    expect(readTrustedMints(OWNER_ID)).toEqual([]);
  });

  it('does not resolve before the trusted-mint merge commits', async () => {
    await installProvenOwner();
    const locks = new DeferredLocks();
    vi.stubGlobal('navigator', { locks });

    let settled = false;
    const restoring = applyBackup(backup('backup-mint.example', KEY_A), OWNER_ID).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(locks.requests).toHaveLength(1));

    expect(settled).toBe(false);
    await locks.releaseNext();

    expect((await restoring).trustedMintsAdded).toBe(1);
    const restored = readTrustedMints(OWNER_ID);
    expect(restored).toEqual([
      expect.objectContaining({
        server: 'backup-mint.example',
        mintPubkey: KEY_A,
        locked: false,
        unconfirmed: true,
      }),
    ]);
    expect(restored[0]?.pendingMintPubkey).toBeUndefined();
  });

  it('keeps a local locked pin and pending rekey authoritative', async () => {
    await installProvenOwner();
    localStorage.setItem(
      'sattle_trusted_mints',
      JSON.stringify({
        version: 1,
        ownerId: OWNER_ID,
        mints: [
          {
            server: 'local.example',
            mintPubkey: KEY_A,
            addedAt: 1,
            locked: true,
            pendingMintPubkey: KEY_B,
          },
        ],
      }),
    );

    const result = await applyBackup(backup('local.example', KEY_B), OWNER_ID);

    expect(result.trustedMintsAdded).toBe(0);
    expect(readTrustedMints(OWNER_ID)).toEqual([
      expect.objectContaining({
        mintPubkey: KEY_A,
        locked: true,
        pendingMintPubkey: KEY_B,
      }),
    ]);
  });
});

describe('backup counter projection', () => {
  const fundsDoc = (nextByHost: Record<string, number>) => ({
    version: 2 as const,
    bearers: [] as { id: string; iv: string; ciphertext: string }[],
    pending: [] as { id: string; kind: string; phase: string; iv: string; ciphertext: string }[],
    nextByHost,
    revision: 1,
  });

  it('exports the counters and never the pending journal', () => {
    const doc = fundsDoc({ 'mint.example': 5 });
    doc.pending.push({
      id: 'pending-sentinel-never-exported',
      kind: 'cash-allocation',
      phase: 'reserved',
      iv: '00',
      ciphertext: '00',
    });
    writeFundsDocument(doc);

    const built = buildBackup(OWNER_ID);

    expect(built.version).toBe(2);
    expect(built.nextByHost).toEqual({ 'mint.example': 5 });
    expect('pending' in built).toBe(false);
    expect(JSON.stringify(built)).not.toContain('pending-sentinel-never-exported');
  });

  it('round-trips counters through a restore and merges upward-only', async () => {
    writeFundsDocument(fundsDoc({ 'mint.example': 5, 'other.example': 2 }));

    const result = await applyBackup({
      type: 'sattle-backup',
      version: 2,
      createdAt: 1,
      bearers: [],
      nextByHost: { 'mint.example': 3, 'other.example': 9, 'new.example': 4 },
    });

    expect(result.added).toBe(0);
    // lower incoming values never rewind a counter; higher ones advance it;
    // unknown hosts adopt the backup's value
    expect(readFundsDocument().nextByHost).toEqual({
      'mint.example': 5,
      'other.example': 9,
      'new.example': 4,
    });
  });

  it('skips out-of-bounds counter entries instead of rejecting the restore', async () => {
    writeFundsDocument(fundsDoc({ 'mint.example': 5 }));

    await applyBackup({
      type: 'sattle-backup',
      version: 2,
      createdAt: 1,
      bearers: [],
      nextByHost: {
        [`${'h'.repeat(254)}`]: 9,
        'overflow.example': 2 ** 31,
        'negative.example': -1,
        'fractional.example': 1.5,
        'valid.example': 7,
      },
    });

    expect(readFundsDocument().nextByHost).toEqual({ 'mint.example': 5, 'valid.example': 7 });
  });

  it('never grows the counter map beyond ten hosts on restore', async () => {
    const incoming: Record<string, number> = {};
    for (let i = 0; i < 12; i += 1) incoming[`mint-${i}.example`] = i + 1;

    await applyBackup({
      type: 'sattle-backup',
      version: 2,
      createdAt: 1,
      bearers: [],
      nextByHost: incoming,
    });

    const merged = readFundsDocument().nextByHost;
    expect(Object.keys(merged)).toHaveLength(10);
  });

  it('rejects a legacy version-1 backup file', () => {
    expect(() =>
      parseBackupFile({ type: 'sattle-backup', version: 1, createdAt: 1, bearers: [] }),
    ).toThrow('Not a valid sattle backup file.');
  });

  it('rejects a v2 file without a counter map', () => {
    expect(() =>
      parseBackupFile({ type: 'sattle-backup', version: 2, createdAt: 1, bearers: [] }),
    ).toThrow('Not a valid sattle backup file.');
  });
});
