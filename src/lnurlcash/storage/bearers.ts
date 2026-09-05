// allow: SIZE_OK — one document, one lock, one write path; splitting the
// schema from its commit primitive would invite drift between them.
//
// The funds document: every fund-critical fact lives in ONE localStorage
// value, `sattle_funds_v2` - encrypted bearer records, the pending-mutation
// journal (opaque encrypted records; the per-flow taxonomy is defined by the
// recovery seam, not here), the per-host BIP-32 next-unused cash indices, and
// a monotonic revision. A note URL - which IS the money - never touches disk
// in plaintext: bearers and journal payloads are AES-GCM ciphertexts under a
// key derived from the linking key (see keys.ts).
//
// Why one document: a counter bump without its staged outputs (or vice
// versa) is how indices get burned twice or fresh secrets get lost. Because
// everything shares one key, one locked fresh-read…write commits or fails as
// a unit, and one getItem is a consistent snapshot for backups.
//
// Mutation discipline (fund-critical, non-negotiable):
// - EVERY mutation runs inside withRequiredStorageLock on the document key:
//   fresh-read the document, re-validate, run the caller's owner fence,
//   reserve counter indices, derive/encrypt, then ONE setItem. There is no
//   unlocked fallback - without Web Locks a second tab could interleave a
//   fresh-read…write and burn the same BIP-32 index twice, so mutations fail
//   closed (StorageLocksUnavailableError) before any derivation, encryption,
//   or I/O. Reads never need the lock.
// - encryption happens INSIDE the lock: the staged payload depends on the
//   reserved range, which only exists once the counter bump is serialized.
//   Web Locks callbacks may be async; holding the lock across crypto costs
//   latency but never correctness, and the alternative (encrypt first,
//   re-read later) cannot express counter reservation at all.
// - any failure (crypto, quota, fence, overflow) rejects with the document
//   bytes untouched and zero network I/O performed.

import type { EncryptedRecordParts } from '../keys';
import { encryptRecord, decryptRecord } from '../keys';
import type { Bearer, NewBearer } from '../types';
import { isJsonObject } from '../jsonParsing';
import { noteK1, serverOf } from 'lnurlcash-kit';
import {
  StorageLocksUnavailableError,
  storageLocksAvailable,
  withRequiredStorageLock,
} from '../storageLock';

// the wallet's default note order (newest first) with manually dragged
// notes taking priority once they have an explicit rank
export const compareBearerOrder = (a: Bearer, b: Bearer): number =>
  (a.sortIndex ?? -a.createdAt) - (b.sortIndex ?? -b.createdAt);

export type EncryptedBearerRecord = { id: string } & EncryptedRecordParts;

// the forward-compatible pending-mutation journal slot: an opaque encrypted
// payload behind a kind/phase pair. The per-flow variants (rotate, split,
// merge, mint, melt-return, transfer) are defined by the recovery seam; this
// layer only guarantees they persist atomically with everything else.
export type EncryptedJournalRecord = {
  id: string;
  kind: string;
  phase: string;
} & EncryptedRecordParts;

export const FUNDS_STORAGE_KEY = 'sattle_funds_v2';
export const FUNDS_DOCUMENT_VERSION = 2 as const;

// counter bounds: BIP-32 indices stay below the hardened offset; the host
// map stays small enough that a corrupt or hostile restore cannot exhaust
// quota or smuggle unbounded state (253 = DNS name ceiling)
export const MAX_CASH_INDEX = 2 ** 31;
export const MAX_COUNTER_HOSTS = 10;
export const MAX_COUNTER_HOST_LENGTH = 253;

export type StoredFundsV2 = {
  version: typeof FUNDS_DOCUMENT_VERSION;
  bearers: EncryptedBearerRecord[];
  pending: EncryptedJournalRecord[];
  nextByHost: Record<string, number>;
  revision: number;
};

const isEncryptedBearerRecord = (value: unknown): value is EncryptedBearerRecord =>
  isJsonObject(value) &&
  typeof value.id === 'string' &&
  typeof value.iv === 'string' &&
  typeof value.ciphertext === 'string';

const isEncryptedJournalRecord = (value: unknown): value is EncryptedJournalRecord =>
  isEncryptedBearerRecord(value) &&
  typeof (value as EncryptedJournalRecord).kind === 'string' &&
  typeof (value as EncryptedJournalRecord).phase === 'string';

const isValidCounter = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < MAX_CASH_INDEX;

const isStoredBearer = (value: unknown): value is Omit<Bearer, 'id'> =>
  isJsonObject(value) &&
  typeof value.url === 'string' &&
  typeof value.callback === 'string' &&
  typeof value.amount === 'number' &&
  typeof value.verified === 'boolean' &&
  typeof value.createdAt === 'number' &&
  typeof value.updatedAt === 'number' &&
  (value.mintPubkey === undefined || typeof value.mintPubkey === 'string') &&
  (value.spent === undefined || typeof value.spent === 'boolean') &&
  (value.sortIndex === undefined || typeof value.sortIndex === 'number') &&
  (value.label === undefined || typeof value.label === 'string') &&
  (value.deviceId === undefined || typeof value.deviceId === 'string') &&
  (value.pendingMint === undefined ||
    (isJsonObject(value.pendingMint) &&
      (value.pendingMint.sourceBearerId === undefined ||
        typeof value.pendingMint.sourceBearerId === 'string') &&
      (value.pendingMint.sourceRecoverySecret === undefined ||
        typeof value.pendingMint.sourceRecoverySecret === 'string') &&
      (value.pendingMint.mintPubkey === undefined ||
        typeof value.pendingMint.mintPubkey === 'string') &&
      (value.pendingMint.retireAfter === undefined ||
        (typeof value.pendingMint.retireAfter === 'number' &&
          Number.isSafeInteger(value.pendingMint.retireAfter) &&
          value.pendingMint.retireAfter > 0))));

export const newBearerId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const emptyFundsDocument = (): StoredFundsV2 => ({
  version: FUNDS_DOCUMENT_VERSION,
  bearers: [],
  pending: [],
  nextByHost: {},
  revision: 0,
});

// strict shape, tolerant read: anything that is not a well-formed v2
// document reads as the empty document (the long-standing "never throw on
// read" contract - a corrupt blob must not wedge the wallet), and malformed
// entries inside a valid document are dropped, never thrown on
const parseFundsDocument = (value: unknown): StoredFundsV2 | null => {
  if (!isJsonObject(value) || value.version !== FUNDS_DOCUMENT_VERSION) return null;
  if (!Array.isArray(value.bearers) || !Array.isArray(value.pending)) return null;
  if (!isJsonObject(value.nextByHost)) return null;
  if (
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  ) {
    return null;
  }
  const nextByHost: Record<string, number> = {};
  for (const [host, next] of Object.entries(value.nextByHost)) {
    if (host.length === 0 || host.length > MAX_COUNTER_HOST_LENGTH || !isValidCounter(next)) {
      continue;
    }
    nextByHost[host] = next;
  }
  return {
    version: FUNDS_DOCUMENT_VERSION,
    bearers: value.bearers.filter(isEncryptedBearerRecord),
    pending: value.pending.filter(isEncryptedJournalRecord),
    nextByHost,
    revision: value.revision,
  };
};

export const readFundsDocument = (): StoredFundsV2 => {
  const raw = localStorage.getItem(FUNDS_STORAGE_KEY);
  if (!raw) return emptyFundsDocument();
  try {
    return parseFundsDocument(JSON.parse(raw)) ?? emptyFundsDocument();
  } catch {
    return emptyFundsDocument();
  }
};

export const writeFundsDocument = (doc: StoredFundsV2): void => {
  localStorage.setItem(FUNDS_STORAGE_KEY, JSON.stringify(doc));
};

export const readEncryptedBearers = (): EncryptedBearerRecord[] => readFundsDocument().bearers;

export const readPendingJournal = (): EncryptedJournalRecord[] => readFundsDocument().pending;

export const readNextByHost = (): Record<string, number> => ({ ...readFundsDocument().nextByHost });

export const readFundsRevision = (): number => readFundsDocument().revision;

type BearerCommitOptions = { beforeCommit?: () => void };

// mutations have no unlocked fallback: reject BEFORE any derivation or
// encryption when cross-tab serialization cannot be guaranteed
const requireMutationLocks = (): void => {
  if (!storageLocksAvailable()) throw new StorageLocksUnavailableError();
};

// decrypts everything currently stored - a record that fails to decrypt
// (e.g. written by a different seed's key) is skipped, not destroyed: it
// stays in localStorage untouched and simply doesn't show up
export const loadBearers = async (aesKey: CryptoKey): Promise<Bearer[]> => {
  const bearers: Bearer[] = [];
  for (const record of readEncryptedBearers()) {
    try {
      const bearer = await decryptRecord(aesKey, record);
      if (!isStoredBearer(bearer)) throw new Error('Malformed encrypted bearer record.');
      bearers.push({ ...bearer, id: record.id });
    } catch (error) {
      // undecryptable with this key - leave it in place
      if (!(error instanceof Error)) throw error;
    }
  }
  return bearers.sort((a, b) => b.createdAt - a.createdAt);
};

export const persistBearer = async (
  aesKey: CryptoKey,
  bearer: Bearer,
  options: BearerCommitOptions = {},
): Promise<void> => {
  requireMutationLocks();
  const { id, ...plain } = bearer;
  await withRequiredStorageLock(FUNDS_STORAGE_KEY, async () => {
    const doc = readFundsDocument();
    options.beforeCommit?.();
    const parts = await encryptRecord(aesKey, plain);
    doc.bearers = doc.bearers.filter((r) => r.id !== id);
    doc.bearers.push({ id, ...parts });
    doc.revision += 1;
    writeFundsDocument(doc);
  });
};

export const deleteBearerRecord = async (
  id: string,
  options: BearerCommitOptions = {},
): Promise<void> => {
  requireMutationLocks();
  await withRequiredStorageLock(FUNDS_STORAGE_KEY, () => {
    const doc = readFundsDocument();
    options.beforeCommit?.();
    doc.bearers = doc.bearers.filter((r) => r.id !== id);
    doc.revision += 1;
    writeFundsDocument(doc);
  });
};

// The atomic unit of bearer persistence: fresh notes to start tracking plus
// ids of snapshot notes to lock as spent. Born-spent notes (carved and
// melted away in one flow) are deliberately not representable - they were
// never the wallet's money in a trackable state. clearPending removes
// pending-journal records (by id) in the SAME write, which is how a
// finalized staged mutation retires its journal entry atomically with the
// bearer changes that settle it.
export type BearerChangeset = {
  add: NewBearer[];
  markSpent: string[];
  upsert?: Bearer[];
  remove?: string[];
  clearPending?: string[];
};

// Commits a whole changeset as ONE funds-document write - the fund-critical
// boundary a caller (NWC service, wallet store) awaits before reporting
// success. Nothing becomes observable until the single locked write lands:
//
// - the caller's snapshot is only a PLAN: inside the lock the document is
//   re-read FRESH, so records another tab committed after the snapshot
//   survive the upsert - changed ids replace their stored copy, everything
//   else is kept as-is (unrelated records are never decrypted or
//   re-encrypted)
// - added notes get their id/timestamps assigned HERE (so state and storage
//   can never disagree about them), spent marks copy the snapshot's record
// - the owner fence (options.beforeCommit) runs INSIDE the lock after the
//   fresh read and before any encryption: throwing aborts the commit with
//   the document untouched
// - markSpent ids absent from the snapshot are ignored: deriving them would
//   require decrypting a record the caller doesn't hold
// - a changeset that changes nothing performs no write at all
// - caller arrays are never mutated
//
// Returns the next local bearer list (additions first, then the snapshot
// with spent marks applied) only after the write succeeded; on any failure
// the promise rejects and persisted state is untouched.
export const applyBearerChangeset = async (
  aesKey: CryptoKey,
  snapshot: Bearer[],
  changeset: BearerChangeset,
  options: BearerCommitOptions = {},
): Promise<Bearer[]> => {
  const now = Date.now();
  const added: Bearer[] = changeset.add.map((note) => ({
    id: newBearerId(),
    ...note,
    createdAt: now,
    updatedAt: now,
  }));
  const spentIds = new Set(changeset.markSpent);
  const spent = new Map<string, Bearer>();
  for (const bearer of snapshot) {
    if (spentIds.has(bearer.id)) {
      spent.set(bearer.id, { ...bearer, spent: true, updatedAt: now });
    }
  }
  const upserted = changeset.upsert ?? [];
  const removedIds = new Set(changeset.remove ?? []);
  const clearPendingIds = new Set(changeset.clearPending ?? []);
  const changedById = new Map<string, Bearer>();
  for (const bearer of spent.values()) changedById.set(bearer.id, bearer);
  for (const bearer of upserted) changedById.set(bearer.id, bearer);
  for (const bearer of added) changedById.set(bearer.id, bearer);
  const changed = [...changedById.values()];
  if (changed.length === 0 && removedIds.size === 0 && clearPendingIds.size === 0) return snapshot;
  requireMutationLocks();
  await withRequiredStorageLock(FUNDS_STORAGE_KEY, async () => {
    const doc = readFundsDocument();
    options.beforeCommit?.();
    const encrypted: EncryptedBearerRecord[] = [];
    for (const bearer of changed) {
      const { id, ...plain } = bearer;
      const parts = await encryptRecord(aesKey, plain);
      encrypted.push({ id, ...parts });
    }
    const changedIds = new Set(encrypted.map((r) => r.id));
    doc.bearers = doc.bearers.filter(
      (record) => !changedIds.has(record.id) && !removedIds.has(record.id),
    );
    doc.bearers.push(...encrypted);
    if (clearPendingIds.size > 0) {
      doc.pending = doc.pending.filter((record) => !clearPendingIds.has(record.id));
    }
    doc.revision += 1;
    writeFundsDocument(doc);
  });
  const snapshotIds = new Set(snapshot.map((bearer) => bearer.id));
  const inserted = upserted.filter((bearer) => !snapshotIds.has(bearer.id));
  const retained = snapshot
    .filter((bearer) => !removedIds.has(bearer.id))
    .map((bearer) => changedById.get(bearer.id) ?? bearer);
  return [...added, ...inserted, ...retained];
};

// ---- counter reservation ----

export type FundsReservation = { host: string; count: number };
export type ReservedCashRange = { host: string; start: number; count: number };

// what the caller wants staged for the reserved range - the payload is
// opaque to this layer (encrypted as-is); kind/phase let the recovery seam
// route it later
export type PendingStaging = { kind: string; phase: string; payload: object };

const assertValidReservation = ({ host, count }: FundsReservation): void => {
  if (typeof host !== 'string' || host.length === 0 || host.length > MAX_COUNTER_HOST_LENGTH) {
    throw new Error(
      `A counter host is a canonical server name of at most ${MAX_COUNTER_HOST_LENGTH} characters.`,
    );
  }
  if (!Number.isSafeInteger(count) || count < 1 || count >= MAX_CASH_INDEX) {
    throw new Error('A reservation count is a positive safe integer below 2^31.');
  }
};

// Reserves `count` fresh BIP-32 indices for a canonical host and stages one
// encrypted pending-journal record for them - allocation plus staging in ONE
// locked write, before any mutation may reach a mint. The reserved range is
// only known once the counter bump is serialized, so the caller's `stage`
// callback runs INSIDE the lock with the assigned range (that is where the
// secrets for [start, start+count) get derived and encrypted into the
// payload). Burned gaps are never reused: a crash after this commit leaves
// the counter advanced, which is safe - reuse never is.
//
// Rejects - with the document bytes untouched and no encryption performed -
// on a stale owner fence, an overlong host, an eleventh counter host, and
// counter exhaustion at the 2^31 BIP-32 ceiling.
export const reserveCashIndices = async (
  aesKey: CryptoKey,
  reservation: FundsReservation,
  stage: (reserved: ReservedCashRange) => PendingStaging,
  options: BearerCommitOptions = {},
): Promise<ReservedCashRange & { pendingId: string }> => {
  assertValidReservation(reservation);
  requireMutationLocks();
  const { host, count } = reservation;
  return withRequiredStorageLock(FUNDS_STORAGE_KEY, async () => {
    const doc = readFundsDocument();
    options.beforeCommit?.();
    const start = doc.nextByHost[host] ?? 0;
    if (doc.nextByHost[host] === undefined) {
      if (Object.keys(doc.nextByHost).length >= MAX_COUNTER_HOSTS) {
        throw new Error(
          `The wallet already tracks counters for ${MAX_COUNTER_HOSTS} mint hosts; no room for another.`,
        );
      }
    }
    if (start + count >= MAX_CASH_INDEX) {
      throw new Error('The cash index space for this mint host is exhausted.');
    }
    const staged = stage({ host, start, count });
    if (typeof staged.kind !== 'string' || typeof staged.phase !== 'string') {
      throw new Error('A staged pending record needs string kind and phase.');
    }
    const parts = await encryptRecord(aesKey, staged.payload);
    const pendingId = newBearerId();
    doc.pending.push({ id: pendingId, kind: staged.kind, phase: staged.phase, ...parts });
    doc.nextByHost[host] = start + count;
    doc.revision += 1;
    writeFundsDocument(doc);
    return { host, start, count, pendingId };
  });
};

export type FundsRestoreMerge = { added: number; skipped: number };

// The funds half of a backup restore, as one locked write: bearer records
// union by id (already-present ids are left as-is, never overwritten) and
// counters merge upward-only - max(local, incoming) per host, so a stale
// backup can never rewind a counter and reopen burned indices. Local hosts
// always keep their slot; incoming hosts beyond the counter cap are skipped.
// Invalid incoming entries are skipped, never thrown on (same policy as the
// bearer records). Pending journal state is device-local and never part of
// a backup, so it is not a parameter here at all.
export const commitFundsRestore = async (
  bearersToMerge: EncryptedBearerRecord[],
  countersToMerge: Record<string, number>,
): Promise<FundsRestoreMerge> => {
  const counters = Object.entries(countersToMerge).filter(
    ([host, next]) =>
      host.length > 0 && host.length <= MAX_COUNTER_HOST_LENGTH && isValidCounter(next),
  );
  if (bearersToMerge.length === 0 && counters.length === 0) {
    return { added: 0, skipped: 0 };
  }
  requireMutationLocks();
  return withRequiredStorageLock(FUNDS_STORAGE_KEY, () => {
    const doc = readFundsDocument();
    const existingIds = new Set(doc.bearers.map((r) => r.id));
    let added = 0;
    let skipped = 0;
    for (const record of bearersToMerge) {
      if (!isEncryptedBearerRecord(record) || existingIds.has(record.id)) {
        skipped++;
        continue;
      }
      doc.bearers.push({ id: record.id, iv: record.iv, ciphertext: record.ciphertext });
      existingIds.add(record.id);
      added++;
    }
    for (const [host, next] of counters) {
      const local = doc.nextByHost[host];
      if (local === undefined) {
        if (Object.keys(doc.nextByHost).length >= MAX_COUNTER_HOSTS) continue;
        doc.nextByHost[host] = next;
      } else if (next > local) {
        doc.nextByHost[host] = next;
      }
    }
    doc.revision += 1;
    writeFundsDocument(doc);
    return { added, skipped };
  });
};

// wipes every bearer record from this device outright - unlike forgetting
// just the linking key, this is not recoverable by restoring the same seed:
// the ciphertexts themselves are gone, so only a previously downloaded
// backup file can bring them back
export const clearAllBearers = (): void => {
  localStorage.removeItem(FUNDS_STORAGE_KEY);
};

// Merge two decrypted bearer lists into one, keyed by note identity
// (issuing server + k1 secret), falling back to record id for notes whose
// k1 is absent (a paired-device mirror carries none). Union semantics with
// spent-wins: when both lists hold the same note, the copy locked as spent
// always survives over a still-spendable one - a spent note that "comes
// back" after a restore is how double-spends are born. Among copies in the
// same spent state, the newer updatedAt wins. This is the merge a restore
// (backup file now, nostr later) applies after its records decrypt, and it
// is what makes multi-device restores converge instead of duplicate.
export const mergeBearers = (current: Bearer[], incoming: Bearer[]): Bearer[] => {
  const keyOf = (b: Bearer): string => {
    const k1 = noteK1(b.url);
    return k1 ? `${serverOf(b.url)}#${k1}` : `id#${b.id}`;
  };
  const merged = new Map<string, Bearer>();
  for (const bearer of [...current, ...incoming]) {
    const key = keyOf(bearer);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, bearer);
      continue;
    }
    if (bearer.spent !== existing.spent) {
      merged.set(key, bearer.spent ? bearer : existing);
      continue;
    }
    merged.set(key, bearer.updatedAt >= existing.updatedAt ? bearer : existing);
  }
  return [...merged.values()].sort((a, b) => b.createdAt - a.createdAt);
};
