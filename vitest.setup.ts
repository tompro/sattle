// vitest setup (registered via setupFiles in vitest.config.ts).
//
// CI runs the suite on Node 22, where navigator.locks does not exist, so
// the fail-closed fund-mutation guard (withRequiredStorageLock) rejects
// every mutation; locally on Node 24 the native Web Locks are present.
// Install a minimal in-memory LockManager where locks are absent so the
// suite is hermetic across Node 20/22/24. It serializes same-name
// requests like the real API (storageLock.test.ts asserts that ordering)
// but gives no cross-tab guarantee - the same trade-off as
// withStorageLock's unlocked fallback. Tests that exercise the no-locks
// refusal stub navigator themselves (vi.stubGlobal('navigator', {})),
// which overrides this install. FORCE_STUB_LOCKS=1 replaces the native
// LockManager too, proving the suite never depends on real lock semantics.

const createPassthroughLockManager = (): {
  request: (name: string, callback: () => unknown) => Promise<unknown>;
} => {
  const tail = new Map<string, Promise<unknown>>();
  return {
    request: (name, callback) => {
      const previous = tail.get(name) ?? Promise.resolve();
      const result = previous.then(callback);
      tail.set(
        name,
        result.then(
          () => undefined,
          () => undefined,
        ),
      );
      return result;
    },
  };
};

const installPassthroughLocks = (): void => {
  const locks = createPassthroughLockManager();
  const navigator = globalThis.navigator;
  if (typeof navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', {
      value: { locks },
      configurable: true,
      enumerable: false,
      writable: true,
    });
    return;
  }
  Object.defineProperty(navigator, 'locks', {
    value: locks,
    configurable: true,
    writable: true,
  });
};

const locksAbsent =
  typeof globalThis.navigator === 'undefined' ||
  !('locks' in globalThis.navigator) ||
  !globalThis.navigator.locks;

if (process.env.FORCE_STUB_LOCKS === '1' || locksAbsent) {
  installPassthroughLocks();
}
