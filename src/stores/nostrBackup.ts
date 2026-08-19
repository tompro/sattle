import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';

import type { BackupPartPayload, BackupPublisher } from '@/lnurlcash/nostrBackup';
import {
  backupPubkey,
  createBackupPublisher,
  deriveBackupKey,
  publishBackup,
  restoreFromNostr,
} from '@/lnurlcash/nostrBackup';
import type { NostrRestoreResult } from '@/lnurlcash/nostrBackup';
import { loadSettings, persistSettings, readEncryptedBearers } from '@/lnurlcash/storage';
import { readTrustedMints } from '@/lnurlcash/trustedMints';
import { useWalletStore } from './wallet';
import { useMintsStore } from './mints';

// a small set of well-known, long-lived relays - editable in the UI, and
// only persisted once the holder actually changes them (absent = defaults)
export const DEFAULT_NOSTR_RELAYS: readonly string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

// bursts of edits (a receive plus its mint trust plus a settings change)
// collapse into one publish of the final state per quiet window
const PUBLISH_DEBOUNCE_MS = 5000;

export const normalizeRelay = (input: string): string => {
  const relay = input.trim().toLowerCase().replace(/\/+$/, '');
  if (!/^wss?:\/\/\S+$/.test(relay)) {
    throw new Error('A relay is a WebSocket URL, like wss://relay.example.com.');
  }
  return relay;
};

// The nostr-backup control surface: the enabled/relays settings (persisted
// in wallet settings), the debounced publisher wired to store changes while
// the wallet is unlocked, and the manual back-up/restore actions. The
// engine (lnurlcash/nostrBackup.ts) stays framework-free; everything
// reactive lives here.
export const useNostrBackupStore = defineStore('nostrBackup', () => {
  const wallet = useWalletStore();
  const mints = useMintsStore();

  const settings = loadSettings();
  const enabled = ref(settings.nostrBackupEnabled ?? false);
  const relays = ref<string[]>(
    settings.nostrBackupRelays && settings.nostrBackupRelays.length > 0
      ? [...settings.nostrBackupRelays]
      : [...DEFAULT_NOSTR_RELAYS],
  );

  // feedback for the backup page: when the last publish went out, or why
  // the last attempt failed (a debounced publish has no caller to throw to)
  const lastPublishAt = ref<number | null>(null);
  const lastError = ref('');

  // the backup identity is derived from the linking key, so it only exists
  // while unlocked - locked renders must never touch requireLinkingKey
  const pubkey = computed(() =>
    wallet.state === 'unlocked' ? backupPubkey(deriveBackupKey(wallet.requireLinkingKey())) : null,
  );

  const currentPayload = (): BackupPartPayload => ({
    notes: readEncryptedBearers(),
    mints: readTrustedMints(),
    settings: loadSettings(),
  });

  const publishNow = async (): Promise<void> => {
    const secretKey = deriveBackupKey(wallet.requireLinkingKey());
    await publishBackup(secretKey, currentPayload(), relays.value);
    lastPublishAt.value = Date.now();
  };

  // ---- debounced publishing lifecycle ----
  // wired while (unlocked AND enabled) only; both the watchers and the
  // publisher are torn down the moment either flips, so a locked wallet
  // never schedules anything and holds no key-material closure
  let publisher: BackupPublisher | null = null;
  let stopWatchers: (() => void) | null = null;

  const start = (): void => {
    if (publisher) return;
    publisher = createBackupPublisher({
      delayMs: PUBLISH_DEBOUNCE_MS,
      publish: async (parts) => {
        await publishBackup(deriveBackupKey(wallet.requireLinkingKey()), parts, relays.value);
        lastPublishAt.value = Date.now();
        lastError.value = '';
      },
      onError: (error) => {
        lastError.value = error instanceof Error ? error.message : 'Backup publish failed.';
      },
    });
    const schedule = () => publisher?.schedule(currentPayload());
    const stops = [
      watch(() => wallet.bearers, schedule),
      watch(() => mints.mints, schedule),
      watch(() => mints.defaultMint, schedule),
    ];
    stopWatchers = () => stops.forEach((stop) => stop());
    // an initial publish on (re)activation, so enabling backup on a wallet
    // that then sits idle still lands a backup
    schedule();
  };

  const stop = (): void => {
    stopWatchers?.();
    stopWatchers = null;
    publisher?.cancel();
    publisher = null;
  };

  watch(
    () => [wallet.state, enabled.value] as const,
    ([state, on]) => {
      if (state === 'unlocked' && on) start();
      else stop();
    },
    { immediate: true },
  );

  // ---- settings ----
  const setEnabled = (value: boolean): void => {
    enabled.value = value;
    persistSettings({ ...loadSettings(), nostrBackupEnabled: value });
  };

  const setRelays = (list: string[]): void => {
    relays.value = list;
    persistSettings({ ...loadSettings(), nostrBackupRelays: list });
  };

  // ---- manual actions (the backup page buttons) ----
  const backupNow = async (): Promise<void> => {
    lastError.value = '';
    try {
      await publishNow();
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Backup publish failed.';
      throw error;
    }
  };

  // pulls the newest backup for THIS wallet's key and merges it through the
  // same applyBackup path as a file restore, then reloads the live list
  const restore = async (): Promise<NostrRestoreResult> => {
    const result = await restoreFromNostr(wallet.requireLinkingKey(), relays.value);
    await wallet.reloadBearers();
    return result;
  };

  return {
    enabled,
    relays,
    pubkey,
    lastPublishAt,
    lastError,
    setEnabled,
    setRelays,
    backupNow,
    restore,
  };
});
