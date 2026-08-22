import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWalletIdleWatch } from './walletIdle';

type ListenerMap = Map<string, Set<EventListenerOrEventListenerObject>>;

const stubWindowListeners = (): ListenerMap => {
  const listeners: ListenerMap = new Map();
  vi.stubGlobal('window', {
    addEventListener: (event: string, listener: EventListenerOrEventListenerObject) => {
      const registered = listeners.get(event) ?? new Set();
      registered.add(listener);
      listeners.set(event, registered);
    },
    removeEventListener: (event: string, listener: EventListenerOrEventListenerObject) => {
      listeners.get(event)?.delete(listener);
    },
  });
  return listeners;
};

const fireActivity = (listeners: ListenerMap): void => {
  const handler = listeners.get('mousemove')?.values().next().value;
  if (typeof handler !== 'function') throw new Error('Expected a registered activity listener.');
  handler(new Event('mousemove'));
};

const AUTO_LOCK_MS = 5 * 60 * 1000;
const LOCK_WARNING_MS = 30 * 1000;

const startWatch = (lock: () => Promise<void>) => {
  const listeners = stubWindowListeners();
  let warningSecondsLeft: number | null = null;
  const watch = createWalletIdleWatch({
    isEncrypted: () => true,
    isUnlocked: () => true,
    isLockWarningVisible: () => warningSecondsLeft !== null,
    lock,
    setWarningSecondsLeft: (seconds) => {
      warningSecondsLeft = seconds;
    },
  });
  watch.start();
  return {
    listeners,
    watch,
    warningSecondsLeft: () => warningSecondsLeft,
  };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('wallet idle watch', () => {
  it('locks on schedule once the warning is up, ignoring passive activity', () => {
    // Given an unlocked encrypted wallet idle long enough to show the warning
    const lock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const { listeners, warningSecondsLeft } = startWatch(lock);
    vi.advanceTimersByTime(AUTO_LOCK_MS - LOCK_WARNING_MS + 1000);
    expect(warningSecondsLeft()).toBe(LOCK_WARNING_MS / 1000 - 1);

    // When passive activity arrives while the warning is displayed
    fireActivity(listeners);

    // Then the countdown is NOT reset - only an explicit postpone dismisses
    // the warning, so the "stay unlocked" affordance cannot vanish under the
    // pointer
    vi.advanceTimersByTime(LOCK_WARNING_MS - 1000);
    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('postpones the auto-lock on activity before any warning', () => {
    // Given an unlocked encrypted wallet with regular activity
    const lock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const { listeners, warningSecondsLeft } = startWatch(lock);

    // When activity keeps arriving before the warning threshold
    vi.advanceTimersByTime(AUTO_LOCK_MS - 60 * 1000);
    fireActivity(listeners);
    vi.advanceTimersByTime(AUTO_LOCK_MS - 60 * 1000);

    // Then no warning and no lock
    expect(warningSecondsLeft()).toBeNull();
    expect(lock).not.toHaveBeenCalled();
  });

  it('detaches every activity listener and stops ticking on stop', () => {
    // Given a running watch
    const lock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const { listeners, watch } = startWatch(lock);
    expect(listeners.size).toBeGreaterThan(0);

    // When the watch stops
    watch.stop();

    // Then every window listener is detached and the timer is gone
    expect([...listeners.values()].every((registered) => registered.size === 0)).toBe(true);
    vi.advanceTimersByTime(AUTO_LOCK_MS * 2);
    expect(lock).not.toHaveBeenCalled();
  });

  it('surfaces a rejected auto-lock through the lock promise without an unhandled rejection', async () => {
    // Given an unlocked encrypted wallet whose lock transition fails (the
    // wallet's transition queue records the failure in lifecycleError - the
    // idle watch only owes the promise a consumer)
    const lock = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('NWC drain failed'));
    startWatch(lock);

    // When the idle timeout fires
    vi.advanceTimersByTime(AUTO_LOCK_MS + 1000);
    await vi.advanceTimersByTimeAsync(0);

    // Then the lock was requested and the watch keeps scheduling (a throw
    // escaping the interval callback would kill it)
    expect(lock).toHaveBeenCalled();
    const calls = lock.mock.calls.length;
    vi.advanceTimersByTime(2000);
    expect(lock.mock.calls.length).toBeGreaterThan(calls);
  });
});
