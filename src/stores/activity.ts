import { ref } from 'vue';
import { defineStore } from 'pinia';

import type { ActivityEvent, ActivityKind } from '@/lnurlcash/storage';
import {
  loadActivity,
  persistActivityEvent,
  clearAllActivity,
  newActivityId,
  MAX_ACTIVITY_ENTRIES,
} from '@/lnurlcash/storage';

export class ActivityPersistenceError extends Error {
  override readonly name = 'ActivityPersistenceError';
  readonly actionCommitted = true;

  constructor(options: { cause: unknown }) {
    super(
      'The wallet action completed, but activity history could not be saved. Do not retry the action.',
      options,
    );
  }
}

// The activity log: append-only, encrypted at rest with the same
// bearer-AES key as the notes themselves. Loaded by the wallet store on
// unlock (loadFor) and dropped on lock (unload) - it never holds plaintext
// while the wallet is locked.
export const useActivityStore = defineStore('activity', () => {
  const events = ref<ActivityEvent[]>([]);
  let aesKey: CryptoKey | null = null;

  const loadFor = async (key: CryptoKey): Promise<void> => {
    aesKey = key;
    events.value = await loadActivity(key);
  };

  const unload = (): void => {
    aesKey = null;
    events.value = [];
  };

  // both unload and wipe the stored log - part of forgetting a wallet
  const unloadAndClear = (): void => {
    clearAllActivity();
    unload();
  };

  const log = async (
    kind: ActivityKind,
    message: string,
    onPersistenceError: (error: ActivityPersistenceError) => void,
  ): Promise<void> => {
    if (!aesKey) return;
    const event: ActivityEvent = {
      id: newActivityId(),
      kind,
      message,
      createdAt: Date.now(),
    };
    try {
      await persistActivityEvent(aesKey, event);
    } catch (error) {
      const cause =
        error instanceof Error ? error : new Error('Activity storage failed.', { cause: error });
      onPersistenceError(new ActivityPersistenceError({ cause }));
      return;
    }
    events.value = [event, ...events.value].slice(0, MAX_ACTIVITY_ENTRIES);
  };

  const clear = (): void => {
    clearAllActivity();
    events.value = [];
  };

  return { events, loadFor, unload, unloadAndClear, log, clear };
});
