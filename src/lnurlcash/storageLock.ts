// serializes a read-modify-write cycle across tabs: localStorage access
// itself is per-tab synchronous, so two tabs interleaving read…write can
// lose each other's records (worst case: a stale tab overwrites a freshly
// persisted rotated note after its old k1 was burned). Falls back to
// running unlocked where Web Locks is unavailable (plain-Node tests, very
// old browsers). That fallback provides no cross-tab serialization
// guarantee; the promise hop only normalizes synchronous callback errors.
export const withStorageLock = <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks) return locks.request(name, () => Promise.resolve().then(fn));
  return Promise.resolve().then(fn);
};

export const storageLocksAvailable = (): boolean =>
  typeof navigator !== 'undefined' && navigator.locks !== undefined;

// fund-critical mutations have no fallback: without Web Locks a second tab
// could interleave its own fresh-read…write between this tab's read and
// write and burn the same BIP-32 indices twice (or resurrect a spent note).
// So the funds document refuses to mutate at all where serialization cannot
// be guaranteed - reads stay available, writes fail closed before any key
// derivation, encryption, or network work has happened.
export class StorageLocksUnavailableError extends Error {
  override readonly name = 'StorageLocksUnavailableError';

  constructor() {
    super('This browser cannot guarantee exclusive storage access (Web Locks unavailable).');
  }
}

export const withRequiredStorageLock = <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return Promise.reject(new StorageLocksUnavailableError());
  return locks.request(name, () => Promise.resolve().then(fn));
};
