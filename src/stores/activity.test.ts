import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveBearerAesKey } from '@/lnurlcash/keys';
import type { ActivityEvent } from '@/lnurlcash/storage';
import type * as StorageExports from '@/lnurlcash/storage';
import { stubLocalStorage } from '@/lnurlcash/test-utils';

const persistence = vi.hoisted(() => ({
  persistActivityEvent: vi.fn<(key: CryptoKey, event: ActivityEvent) => Promise<void>>(),
}));

vi.mock('@/lnurlcash/storage', async (importOriginal) => ({
  ...(await importOriginal<typeof StorageExports>()),
  persistActivityEvent: persistence.persistActivityEvent,
}));

import { useActivityStore } from './activity';

const LINKING_KEY = new Uint8Array(32).fill(7);

beforeEach(() => {
  vi.clearAllMocks();
  stubLocalStorage();
  setActivePinia(createPinia());
});

describe('activity store durability', () => {
  it('publishes an event only after its encrypted write completes', async () => {
    let finishWrite: (() => void) | undefined;
    persistence.persistActivityEvent.mockReturnValue(
      new Promise<void>((resolve) => {
        finishWrite = resolve;
      }),
    );
    const activity = useActivityStore();
    await activity.loadFor(await deriveBearerAesKey(LINKING_KEY));

    const logging = activity.log('receive', 'Received funds.', () => {
      throw new Error('Unexpected persistence failure.');
    });

    expect(activity.events).toEqual([]);
    finishWrite?.();
    await logging;
    expect(activity.events).toHaveLength(1);
  });

  it('rejects a failed write without leaving a false reactive event', async () => {
    const writeError = new Error('activity storage unavailable');
    persistence.persistActivityEvent.mockRejectedValue(writeError);
    const activity = useActivityStore();
    await activity.loadFor(await deriveBearerAesKey(LINKING_KEY));

    let surfaced: Error | null = null;
    await activity.log('receive', 'Received funds.', (error) => {
      surfaced = error;
    });

    expect(activity.events).toEqual([]);
    expect(surfaced).toMatchObject({
      name: 'ActivityPersistenceError',
      actionCommitted: true,
      cause: writeError,
    });
  });
});
