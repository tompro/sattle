const AUTO_LOCK_MS = 5 * 60 * 1000;
const LOCK_WARNING_MS = 30 * 1000;
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'] as const;

type WalletIdleOptions = {
  readonly isEncrypted: () => boolean;
  readonly isUnlocked: () => boolean;
  // once the warning is up, passive activity is deliberately ignored - only
  // postpone() dismisses it, so the "stay unlocked" button can't vanish out
  // from under the pointer before the click lands
  readonly isLockWarningVisible: () => boolean;
  readonly lock: () => Promise<void>;
  readonly setWarningSecondsLeft: (seconds: number | null) => void;
};

export type WalletIdleWatch = {
  readonly start: () => void;
  readonly stop: () => void;
  readonly postpone: () => void;
};

export const createWalletIdleWatch = (options: WalletIdleOptions): WalletIdleWatch => {
  let lastActivity = Date.now();
  let timer: ReturnType<typeof setInterval> | null = null;
  let activityListener: (() => void) | null = null;

  const stop = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (typeof window !== 'undefined' && activityListener !== null) {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, activityListener);
      }
    }
    activityListener = null;
    options.setWarningSecondsLeft(null);
  };

  const postpone = (): void => {
    lastActivity = Date.now();
    options.setWarningSecondsLeft(null);
  };

  const start = (): void => {
    stop();
    if (typeof window === 'undefined' || !options.isEncrypted()) return;
    lastActivity = Date.now();
    activityListener = () => {
      if (options.isUnlocked() && !options.isLockWarningVisible()) {
        lastActivity = Date.now();
      }
    };
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, activityListener, { passive: true });
    }
    timer = setInterval(() => {
      if (!options.isUnlocked()) return;
      const elapsed = Date.now() - lastActivity;
      if (elapsed >= AUTO_LOCK_MS) {
        // lock() routes through the wallet's transition queue, which records
        // any rejection in lifecycleError - the failure IS surfaced there;
        // this catch only keeps the fire-and-forget promise from becoming
        // an unhandled rejection
        void options.lock().catch(() => undefined);
        return;
      }
      if (elapsed >= AUTO_LOCK_MS - LOCK_WARNING_MS) {
        options.setWarningSecondsLeft(Math.ceil((AUTO_LOCK_MS - elapsed) / 1000));
      }
    }, 1000);
  };

  return { start, stop, postpone };
};
