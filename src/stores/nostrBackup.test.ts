// The nostr-backup store's scheduling surface: a counter-only funds commit
// (a BIP-32 reservation that adds no bearer) must still schedule a publish,
// and the published notes payload carries bearers plus counters - never the
// device-local pending journal. The engine's publish is mocked; everything
// below it (debounce, wallet wiring, payload assembly) is real.

import { createPinia, setActivePinia } from 'pinia';
import { deriveCashRoot } from 'lnurlcash-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { publishBackup } from '@/lnurlcash/nostrBackup';
import type * as NostrBackupEngine from '@/lnurlcash/nostrBackup';
import { readFundsDocument } from '@/lnurlcash/storage';
import { stubLocalStorage } from '@/lnurlcash/test-utils';
import { useNostrBackupStore } from './nostrBackup';
import { useWalletStore } from './wallet';

vi.mock('@/lnurlcash/nostrBackup', async (importOriginal) => {
  const actual = await importOriginal<typeof NostrBackupEngine>();
  return { ...actual, publishBackup: vi.fn().mockResolvedValue({ published: [] }) };
});

const CASH_ROOT = deriveCashRoot(new Uint8Array(64).fill(1));

const publishCalls = (): { parts: { notes?: { nextByHost: Record<string, number> } } }[] =>
  vi.mocked(publishBackup).mock.calls.map((call) => ({ parts: call[1] }));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(publishBackup).mockResolvedValue({ published: [] });
  vi.unstubAllGlobals();
  vi.stubGlobal('navigator', {
    locks: { request: (_name: string, fn: () => unknown) => Promise.resolve().then(fn) },
  });
  stubLocalStorage();
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('counter-aware backup scheduling', () => {
  it('schedules a publish for a counter-only reservation and includes the counters', async () => {
    const wallet = useWalletStore();
    await wallet.create();
    const backup = useNostrBackupStore();

    vi.useFakeTimers();
    backup.setEnabled(true);
    // the initial activation publish drains first
    await vi.advanceTimersByTimeAsync(5000);
    expect(publishCalls()).toHaveLength(1);
    vi.mocked(publishBackup).mockClear();

    // a reservation changes no bearer - only the counter map and the pending
    // journal - yet it must still schedule a publish
    await wallet.allocateCashSecrets(CASH_ROOT, 'mint.example', 2, wallet.captureOwnerFence());
    await vi.advanceTimersByTimeAsync(5000);

    const calls = publishCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.parts.notes?.nextByHost).toEqual({ 'mint.example': 2 });
    // the pending journal never leaves the device
    expect(JSON.stringify(calls[0]?.parts)).not.toContain('cash-allocation');
    expect(readFundsDocument().pending).toHaveLength(1);
  });
});
