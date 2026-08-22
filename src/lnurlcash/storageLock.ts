// serializes a read-modify-write cycle across tabs: localStorage access
// itself is per-tab synchronous, so two tabs interleaving read…write can
// lose each other's records (worst case: a stale tab overwrites a freshly
// persisted rotated note after its old k1 was burned). Falls back to
// running unlocked where Web Locks is unavailable (plain-Node tests, very
// old browsers). That fallback provides no cross-tab serialization
// guarantee; the promise hop only normalizes synchronous callback errors.
export const withStorageLock = <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (locks) return locks.request(name, () => Promise.resolve().then(fn))
  return Promise.resolve().then(fn)
}

export const storageLocksAvailable = (): boolean =>
  typeof navigator !== 'undefined' && navigator.locks !== undefined
