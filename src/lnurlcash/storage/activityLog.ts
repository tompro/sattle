// The encrypted activity log: one entry per important wallet action,
// AES-GCM under the same bearer key, append-only, capped so a wallet used
// for years doesn't grow localStorage without limit.

import type { EncryptedRecordParts } from '../keys';
import { encryptRecord, decryptRecord } from '../keys';
import { withStorageLock } from '../storageLock';

// `message` is the full human-readable sentence rather than structured
// fields the UI reassembles, so the log stays simple to read and to extend
// with new kinds later.
export type ActivityKind =
  | 'mint'
  | 'split'
  | 'combine'
  | 'melt'
  | 'transfer'
  | 'receive'
  | 'spent'
  | 'deleted'
  // a payment or mint initiated by a Nostr Wallet Connect client (M5)
  | 'nwc';

export type ActivityEvent = {
  id: string;
  kind: ActivityKind;
  message: string;
  createdAt: number;
};

export type EncryptedActivityRecord = { id: string } & EncryptedRecordParts;

const ACTIVITY_STORAGE_KEY = 'sattle_activity';
// bounds how far back the log ever reaches - the oldest entries simply
// roll off once this many are kept
export const MAX_ACTIVITY_ENTRIES = 500;

export const newActivityId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

export const readEncryptedActivity = (): EncryptedActivityRecord[] => {
  const raw = localStorage.getItem(ACTIVITY_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeEncryptedActivity = (records: EncryptedActivityRecord[]): void => {
  localStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(records));
};

// same tolerance as loadBearers - an entry that fails to decrypt with this
// key (written by a different seed) is skipped, not destroyed
export const loadActivity = async (aesKey: CryptoKey): Promise<ActivityEvent[]> => {
  const events: ActivityEvent[] = [];
  for (const record of readEncryptedActivity()) {
    try {
      const event = await decryptRecord<Omit<ActivityEvent, 'id'>>(aesKey, record);
      events.push({ ...event, id: record.id });
    } catch {
      // undecryptable with this key - leave it in place
    }
  }
  return events.sort((a, b) => b.createdAt - a.createdAt);
};

// append-only (the log never edits or removes a single entry, only clears
// outright - see clearAllActivity) - records are stored oldest-first so
// trimming to the cap is just dropping off the front
export const persistActivityEvent = async (
  aesKey: CryptoKey,
  event: ActivityEvent,
): Promise<void> => {
  const { id, ...plain } = event;
  const parts = await encryptRecord(aesKey, plain);
  await withStorageLock(ACTIVITY_STORAGE_KEY, () => {
    const records = readEncryptedActivity();
    records.push({ id, ...parts });
    writeEncryptedActivity(records.slice(-MAX_ACTIVITY_ENTRIES));
  });
};

export const clearAllActivity = (): void => {
  localStorage.removeItem(ACTIVITY_STORAGE_KEY);
};
