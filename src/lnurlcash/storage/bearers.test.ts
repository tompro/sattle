// Bearer changeset persistence: applyBearerChangeset (the single-write
// commit primitive) plus a baseline pin of the per-record write behavior it
// replaces at the call sites. Lives next to bearers.ts instead of inside
// ../storage.test.ts to keep both files under the project's module size
// ceiling. Runs in Node against an in-memory localStorage stub; WebCrypto
// (crypto.subtle) is native.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNoteUrl } from 'lnurlcash-kit';

import type { Bearer, NewBearer } from '../types';
import { deriveBearerAesKey, encryptRecord } from '../keys';
import { StorageLocksUnavailableError } from '../storageLock';
import {
  applyBearerChangeset,
  loadBearers,
  newBearerId,
  persistBearer,
  readEncryptedBearers,
  reserveCashIndices,
} from '../storage';
import type { BearerChangeset } from '../storage';
import {
  FUNDS_STORAGE_KEY,
  MAX_COUNTER_HOSTS,
  readFundsDocument,
  writeFundsDocument,
} from './bearers';
import { requiredValue, stubLocalStorage } from '../test-utils';
import type { LocalStorageStub } from '../test-utils';
import './bearers.baseline.cases';

const LINKING_KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);

const K1_A = 'aa'.repeat(32);
const K1_B = 'bb'.repeat(32);
const K1_C = 'cc'.repeat(32);
const K1_D = 'dd'.repeat(32);

const bearerFixture = (overrides: Partial<Bearer> = {}): Bearer => ({
  id: newBearerId(),
  url: buildNoteUrl('https://mint.example/w', K1_A, 21_000),
  callback: 'https://mint.example/w/cb',
  amount: 21_000,
  verified: true,
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

const newBearerFixture = (overrides: Partial<NewBearer> = {}): NewBearer => ({
  url: buildNoteUrl('https://mint.example/w', K1_C, 3_000),
  callback: 'https://mint.example/w/cb',
  amount: 3_000,
  verified: true,
  ...overrides,
});

// a present-but-non-serializing LockManager fake: enough for single-writer
// tests that must not trip the no-locks refusal
const stubPassthroughLocks = (): void => {
  vi.stubGlobal('navigator', {
    locks: { request: (_name: string, fn: () => unknown) => Promise.resolve().then(fn) },
  });
};

type LockRequest = {
  readonly name: string;
  readonly callback: () => unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
};

// a controllable Web Locks fake: lock requests park until the test releases
// them, so a foreign write can interleave deterministically
class DeferredLocks {
  readonly requests: LockRequest[] = [];

  readonly request = (name: string, callback: () => unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      this.requests.push({ name, callback, resolve, reject });
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

  readonly stub = (): void => {
    vi.stubGlobal('navigator', { locks: this });
  };
}

let stub: LocalStorageStub;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  stub = stubLocalStorage();
});

const fundsWrites = (spy: { mock: { calls: unknown[][] } }): unknown[][] =>
  spy.mock.calls.filter(([k]) => k === FUNDS_STORAGE_KEY);

describe('stored funds document', () => {
  it('persists one strict v2 document holding bearers, pending, counters and revision', async () => {
    stubPassthroughLocks();
    const key = await deriveBearerAesKey(LINKING_KEY);
    await persistBearer(key, bearerFixture({ id: 'a' }));

    const raw = requiredValue(localStorage.getItem(FUNDS_STORAGE_KEY));
    const doc: unknown = JSON.parse(raw);
    expect(doc).toEqual({
      version: 2,
      bearers: [expect.objectContaining({ id: 'a' })],
      pending: [],
      nextByHost: {},
      revision: 1,
    });
    // strict: exactly these five keys, and the legacy bearer key is gone
    expect(Object.keys(requiredValue(doc as object)).sort()).toEqual([
      'bearers',
      'nextByHost',
      'pending',
      'revision',
      'version',
    ]);
    expect(localStorage.getItem('sattle_bearers')).toBeNull();
  });

  it('bumps the revision on every committed write', async () => {
    stubPassthroughLocks();
    const key = await deriveBearerAesKey(LINKING_KEY);
    await persistBearer(key, bearerFixture({ id: 'a' }));
    await persistBearer(key, bearerFixture({ id: 'b' }));
    expect(readFundsDocument().revision).toBe(2);
  });

  it('reads work without Web Locks', async () => {
    stubPassthroughLocks();
    const key = await deriveBearerAesKey(LINKING_KEY);
    await persistBearer(key, bearerFixture({ id: 'a' }));
    vi.stubGlobal('navigator', {});

    expect(readEncryptedBearers().map((r) => r.id)).toEqual(['a']);
    expect(await loadBearers(key)).toHaveLength(1);
    expect(readFundsDocument().revision).toBe(1);
  });

  it('treats a malformed document as empty instead of throwing', () => {
    localStorage.setItem(FUNDS_STORAGE_KEY, JSON.stringify({ version: 2, bearers: 'junk' }));
    expect(readFundsDocument()).toEqual({
      version: 2,
      bearers: [],
      pending: [],
      nextByHost: {},
      revision: 0,
    });
    localStorage.setItem(FUNDS_STORAGE_KEY, 'not json {{{');
    expect(readFundsDocument().bearers).toEqual([]);
  });
});

describe('required locks', () => {
  it('rejects a changeset mutation before any encryption when Web Locks are unavailable', async () => {
    stubPassthroughLocks();
    const key = await deriveBearerAesKey(LINKING_KEY);
    await persistBearer(key, bearerFixture({ id: 'kept' }));
    const before = requiredValue(localStorage.getItem(FUNDS_STORAGE_KEY));
    vi.stubGlobal('navigator', {});
    const encrypt = vi.spyOn(crypto.subtle, 'encrypt');

    await expect(
      applyBearerChangeset(key, [], { add: [newBearerFixture()], markSpent: [] }),
    ).rejects.toBeInstanceOf(StorageLocksUnavailableError);

    expect(encrypt).not.toHaveBeenCalled();
    expect(localStorage.getItem(FUNDS_STORAGE_KEY)).toBe(before);
  });

  it('rejects per-record writes and reservations without Web Locks', async () => {
    vi.stubGlobal('navigator', {});
    const key = await deriveBearerAesKey(LINKING_KEY);
    const encrypt = vi.spyOn(crypto.subtle, 'encrypt');

    await expect(persistBearer(key, bearerFixture({ id: 'a' }))).rejects.toBeInstanceOf(
      StorageLocksUnavailableError,
    );
    await expect(
      reserveCashIndices(key, { host: 'mint.example', count: 1 }, () => ({
        kind: 'cash-allocation',
        phase: 'reserved',
        payload: {},
      })),
    ).rejects.toBeInstanceOf(StorageLocksUnavailableError);

    expect(encrypt).not.toHaveBeenCalled();
    expect(localStorage.getItem(FUNDS_STORAGE_KEY)).toBeNull();
  });
});

describe('applyBearerChangeset (single-write changeset commit)', () => {
  beforeEach(() => {
    stubPassthroughLocks();
  });

  it('commits additions and spent replacements with exactly one write', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY);
    const oldA = bearerFixture({ id: 'old-a' });
    const oldB = bearerFixture({
      id: 'old-b',
      url: buildNoteUrl('https://mint.example/w', K1_B, 5_000),
      amount: 5_000,
    });
    await persistBearer(key, oldA);
    await persistBearer(key, oldB);

    const writes = vi.spyOn(stub, 'setItem');
    const result = await applyBearerChangeset(key, [oldA, oldB], {
      add: [
        newBearerFixture(),
        newBearerFixture({
          url: buildNoteUrl('https://mint.example/w', K1_D, 4_000),
          amount: 4_000,
        }),
      ],
      markSpent: ['old-a', 'old-b'],
    });

    // the whole changeset is ONE setItem on the funds document
    expect(fundsWrites(writes)).toHaveLength(1);

    // the returned next list: additions first, then the snapshot with spent
    // marks applied
    expect(result).toHaveLength(4);
    const addA = requiredValue(result[0]);
    const addB = requiredValue(result[1]);
    const spentA = requiredValue(result[2]);
    const spentB = requiredValue(result[3]);
    expect(addA.id).not.toBe(addB.id);
    expect(addA.amount).toBe(3_000);
    expect(addB.amount).toBe(4_000);
    expect(addA.createdAt).toBe(addA.updatedAt);
    expect(spentA.id).toBe('old-a');
    expect(spentA.spent).toBe(true);
    expect(spentA.updatedAt).toBeGreaterThan(1000);
    expect(spentB.id).toBe('old-b');
    expect(spentB.spent).toBe(true);

    // the source of truth is the reloaded ciphertext, not the return value
    const reloaded = await loadBearers(key);
    expect(reloaded.map((b) => b.id).sort()).toEqual(result.map((b) => b.id).sort());
    expect(requiredValue(reloaded.find((b) => b.id === 'old-a')).spent).toBe(true);
    expect(requiredValue(reloaded.find((b) => b.id === 'old-b')).spent).toBe(true);
    expect(requiredValue(reloaded.find((b) => b.id === addA.id)).spent).toBeUndefined();
    // nothing plaintext leaked: the fresh k1s are ciphertext-only at rest
    const raw = requiredValue(localStorage.getItem(FUNDS_STORAGE_KEY));
    expect(raw).not.toContain(K1_C);
    expect(raw).not.toContain(K1_D);
  });

  it('never mutates the caller snapshot or the changeset', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY);
    const snapshot = [bearerFixture({ id: 's1' })];
    const changeset: BearerChangeset = {
      add: [newBearerFixture()],
      markSpent: ['s1'],
    };

    await applyBearerChangeset(key, snapshot, changeset);

    expect(requiredValue(snapshot[0]).spent).toBeUndefined();
    expect('id' in requiredValue(changeset.add[0])).toBe(false);
    expect(changeset.markSpent).toEqual(['s1']);
  });

  it('persists nothing when encryption fails', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY);
    await persistBearer(key, bearerFixture({ id: 'kept' }));
    const before = requiredValue(localStorage.getItem(FUNDS_STORAGE_KEY));
    // a decrypt-only key makes every AES-GCM encrypt call reject
    const decryptOnly = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(32).fill(3),
      'AES-GCM',
      false,
      ['decrypt'],
    );
    const writes = vi.spyOn(stub, 'setItem');

    await expect(
      applyBearerChangeset(decryptOnly, [], {
        add: [newBearerFixture()],
        markSpent: [],
      }),
    ).rejects.toThrow();

    expect(fundsWrites(writes)).toHaveLength(0);
    expect(localStorage.getItem(FUNDS_STORAGE_KEY)).toBe(before);
    expect(readEncryptedBearers().map((r) => r.id)).toEqual(['kept']);
  });

  it('rejects without a partial write when the storage write itself fails', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY);
    const kept = bearerFixture({ id: 'kept' });
    await persistBearer(key, kept);
    const before = requiredValue(localStorage.getItem(FUNDS_STORAGE_KEY));
    stub.setItem = (): void => {
      throw new Error('QuotaExceededError');
    };

    await expect(
      applyBearerChangeset(key, [kept], {
        add: [newBearerFixture()],
        markSpent: ['kept'],
      }),
    ).rejects.toThrow('QuotaExceededError');

    // nothing was persisted: the document is byte-identical
    expect(localStorage.getItem(FUNDS_STORAGE_KEY)).toBe(before);
  });

  it('upserts changed ids and dedupes repeated markSpent ids', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY);
    const stale = bearerFixture({ id: 'dup', updatedAt: 1000 });
    await persistBearer(key, stale);

    const result = await applyBearerChangeset(key, [stale], {
      add: [],
      markSpent: ['dup', 'dup'],
    });

    // one record per id, never a duplicate append
    expect(readEncryptedBearers().filter((r) => r.id === 'dup')).toHaveLength(1);
    const reloaded = await loadBearers(key);
    expect(reloaded).toHaveLength(1);
    expect(requiredValue(reloaded[0]).spent).toBe(true);
    expect(requiredValue(result[0]).spent).toBe(true);
  });

  it('preserves a record another tab commits between the snapshot and the lock', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY);
    const other = await deriveBearerAesKey(OTHER_KEY);
    const mine = bearerFixture({ id: 'mine' });
    await persistBearer(key, mine);

    const locks = new DeferredLocks();
    locks.stub();
    try {
      const commit = applyBearerChangeset(key, [mine], {
        add: [newBearerFixture()],
        markSpent: [],
      });
      // the lock request arrives before any inside-lock work
      await vi.waitFor(() => {
        expect(locks.requests).toHaveLength(1);
      });
      const queuedLock = requiredValue(locks.requests[0]);
      expect(queuedLock.name).toBe(FUNDS_STORAGE_KEY);

      // while our commit waits on the lock, another tab commits a record we
      // cannot even decrypt (written under a different seed's key)
      const foreign = bearerFixture({
        id: 'foreign-tab',
        url: buildNoteUrl('https://mint.example/w', K1_B, 9_000),
      });
      const { id: foreignId, ...foreignPlain } = foreign;
      const foreignParts = await encryptRecord(other, foreignPlain);
      const doc = readFundsDocument();
      doc.bearers.push({ id: foreignId, ...foreignParts });
      writeFundsDocument(doc);

      await locks.releaseNext();
      const result = await commit;

      // the foreign ciphertext survived our upsert, untouched
      expect(
        readEncryptedBearers()
          .map((r) => r.id)
          .sort(),
      ).toEqual(['foreign-tab', 'mine', requiredValue(result[0]).id].sort());
      expect((await loadBearers(other)).map((b) => b.id)).toEqual(['foreign-tab']);
      expect((await loadBearers(key)).map((b) => b.id).sort()).toEqual(
        ['mine', requiredValue(result[0]).id].sort(),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('aborts the whole write when the inside-lock fence throws', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY);
    await persistBearer(key, bearerFixture({ id: 'kept' }));
    const before = requiredValue(localStorage.getItem(FUNDS_STORAGE_KEY));
    const writes = vi.spyOn(stub, 'setItem');

    await expect(
      applyBearerChangeset(
        key,
        [],
        { add: [newBearerFixture()], markSpent: [] },
        {
          beforeCommit: () => {
            throw new Error('stale owner');
          },
        },
      ),
    ).rejects.toThrow('stale owner');

    expect(fundsWrites(writes)).toHaveLength(0);
    expect(localStorage.getItem(FUNDS_STORAGE_KEY)).toBe(before);
  });

  it('clears pending journal records in the same write as the changeset', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY);
    const staged = await reserveCashIndices(key, { host: 'mint.example', count: 2 }, () => ({
      kind: 'cash-allocation',
      phase: 'reserved',
      payload: { host: 'mint.example', start: 0, count: 2 },
    }));
    const writes = vi.spyOn(stub, 'setItem');

    await applyBearerChangeset(key, [], {
      add: [newBearerFixture()],
      markSpent: [],
      clearPending: [staged.pendingId],
    });

    expect(fundsWrites(writes)).toHaveLength(1);
    expect(readFundsDocument().pending).toEqual([]);
    expect(readFundsDocument().nextByHost).toEqual({ 'mint.example': 2 });
  });

  it('treats corrupted stored JSON as an empty record set instead of throwing', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY);
    localStorage.setItem(FUNDS_STORAGE_KEY, 'not json {{{');

    const result = await applyBearerChangeset(key, [], {
      add: [newBearerFixture()],
      markSpent: ['gone'],
    });

    // readFundsDocument's contract: unparseable storage reads as the empty
    // document - the changeset still commits and its single write replaces
    // the corrupt blob with a valid one
    expect(result).toHaveLength(1);
    expect((await loadBearers(key)).map((b) => b.id)).toEqual([requiredValue(result[0]).id]);
    expect(readFundsDocument().version).toBe(2);
  });

  it('ignores markSpent ids absent from the snapshot and writes nothing when nothing changed', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY);
    const other = await deriveBearerAesKey(OTHER_KEY);
    await persistBearer(other, bearerFixture({ id: 'foreign' }));
    const before = requiredValue(localStorage.getItem(FUNDS_STORAGE_KEY));
    const writes = vi.spyOn(stub, 'setItem');

    // 'foreign' is not in the caller's snapshot; deriving its spent copy
    // would require decrypting an unrelated record, which this primitive
    // never does - so the changeset changes nothing and performs no write
    const result = await applyBearerChangeset(key, [], {
      add: [],
      markSpent: ['foreign'],
    });

    expect(result).toEqual([]);
    expect(fundsWrites(writes)).toHaveLength(0);
    expect(localStorage.getItem(FUNDS_STORAGE_KEY)).toBe(before);
  });
});

describe('reserveCashIndices (counter reservation plus staging)', () => {
  beforeEach(() => {
    stubPassthroughLocks();
  });

  const stage = (reserved: { host: string; start: number; count: number }) => ({
    kind: 'cash-allocation',
    phase: 'reserved',
    payload: reserved,
  });

  it('reserves a range and stages one encrypted pending record in a single write', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY);
    const writes = vi.spyOn(stub, 'setItem');

    const reserved = await reserveCashIndices(key, { host: 'mint.example', count: 3 }, stage);

    expect(reserved).toEqual({
      host: 'mint.example',
      start: 0,
      count: 3,
      pendingId: expect.any(String),
    });
    expect(fundsWrites(writes)).toHaveLength(1);
    const doc = readFundsDocument();
    expect(doc.nextByHost).toEqual({ 'mint.example': 3 });
    expect(doc.revision).toBe(1);
    expect(doc.pending).toHaveLength(1);
    const record = requiredValue(doc.pending[0]);
    expect(record.id).toBe(reserved.pendingId);
    expect(record.kind).toBe('cash-allocation');
    expect(record.phase).toBe('reserved');
    expect(typeof record.iv).toBe('string');
    expect(typeof record.ciphertext).toBe('string');
    // the staged payload is ciphertext-only at rest
    const raw = requiredValue(localStorage.getItem(FUNDS_STORAGE_KEY));
    expect(raw).not.toContain('"start":0');
  });

  it('hands two same-host tabs disjoint ranges under a contended lock', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY);
    const locks = new DeferredLocks();
    locks.stub();

    // both tabs request the same lock; B's callback must not run (and must
    // not fresh-read) until A's reservation has fully landed
    const tabA = reserveCashIndices(key, { host: 'mint.example', count: 3 }, stage);
    const tabB = reserveCashIndices(key, { host: 'mint.example', count: 2 }, stage);
    await vi.waitFor(() => expect(locks.requests).toHaveLength(2));

    await locks.releaseNext();
    // A committed; B is still parked on the lock with no counter consumed
    expect(readFundsDocument().nextByHost).toEqual({ 'mint.example': 3 });
    await locks.releaseNext();

    const [a, b] = await Promise.all([tabA, tabB]);
    expect(a.start).toBe(0);
    expect(b.start).toBe(3);
    const doc = readFundsDocument();
    expect(doc.nextByHost).toEqual({ 'mint.example': 5 });
    expect(doc.pending).toHaveLength(2);
  });

  it('rejects counter overflow without writing or encrypting', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY);
    const doc = readFundsDocument();
    doc.nextByHost['mint.example'] = 2 ** 31 - 2;
    writeFundsDocument(doc);
    const before = requiredValue(localStorage.getItem(FUNDS_STORAGE_KEY));
    const writes = vi.spyOn(stub, 'setItem');
    const encrypt = vi.spyOn(crypto.subtle, 'encrypt');

    await expect(
      reserveCashIndices(key, { host: 'mint.example', count: 3 }, stage),
    ).rejects.toThrow(/exhausted|overflow/i);

    expect(fundsWrites(writes)).toHaveLength(0);
    expect(encrypt).not.toHaveBeenCalled();
    expect(localStorage.getItem(FUNDS_STORAGE_KEY)).toBe(before);
  });

  it('rejects an overlong host and an eleventh counter host', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY);
    const before = localStorage.getItem(FUNDS_STORAGE_KEY);

    await expect(
      reserveCashIndices(key, { host: `${'h'.repeat(253)}.example`, count: 1 }, stage),
    ).rejects.toThrow(/host/i);
    expect(localStorage.getItem(FUNDS_STORAGE_KEY)).toBe(before);

    const doc = readFundsDocument();
    for (let i = 0; i < MAX_COUNTER_HOSTS; i += 1) {
      doc.nextByHost[`mint-${i}.example`] = 1;
    }
    writeFundsDocument(doc);
    const filled = requiredValue(localStorage.getItem(FUNDS_STORAGE_KEY));

    await expect(
      reserveCashIndices(key, { host: 'mint-overflow.example', count: 1 }, stage),
    ).rejects.toThrow(/host/i);
    expect(localStorage.getItem(FUNDS_STORAGE_KEY)).toBe(filled);
  });

  it('burns no index and writes nothing when the staging encryption fails', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY);
    await persistBearer(key, bearerFixture({ id: 'kept' }));
    const before = requiredValue(localStorage.getItem(FUNDS_STORAGE_KEY));
    const decryptOnly = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(32).fill(3),
      'AES-GCM',
      false,
      ['decrypt'],
    );

    await expect(
      reserveCashIndices(decryptOnly, { host: 'mint.example', count: 2 }, stage),
    ).rejects.toThrow();

    expect(localStorage.getItem(FUNDS_STORAGE_KEY)).toBe(before);
    expect(readFundsDocument().nextByHost).toEqual({});
    expect(readFundsDocument().pending).toEqual([]);
  });

  it('writes nothing when the inside-lock fence throws before reservation', async () => {
    const key = await deriveBearerAesKey(LINKING_KEY);
    const writes = vi.spyOn(stub, 'setItem');

    await expect(
      reserveCashIndices(key, { host: 'mint.example', count: 1 }, stage, {
        beforeCommit: () => {
          throw new Error('stale owner');
        },
      }),
    ).rejects.toThrow('stale owner');

    expect(fundsWrites(writes)).toHaveLength(0);
    expect(localStorage.getItem(FUNDS_STORAGE_KEY)).toBeNull();
  });
});
