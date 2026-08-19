import { ref, watch } from 'vue';
import { defineStore } from 'pinia';

import type {
  CreatedConnection,
  NwcBudget,
  NwcConnectionInfo,
  NwcConnectionRecord,
  NwcMethod,
  NwcChangeset,
  NwcService,
  NwcTransport,
} from '@/lnurlcash/nwc';
import {
  createConnection,
  persistNwcConnection,
  readNwcConnections,
  removeNwcConnection,
  startService,
} from '@/lnurlcash/nwc';
import { msatToSats } from '@/lnurlcash/units';
import { useWalletStore } from './wallet';
import { useMintsStore } from './mints';
import { useActivityStore } from './activity';

// budget period presets the UI offers (the engine speaks raw ms)
export const NWC_PERIOD_DAY_MS = 86_400_000;
export const NWC_PERIOD_WEEK_MS = 604_800_000;

// the engine requires a concrete max (NwcBudget.maxMsat must be > 0) - there
// is no "unlimited"; this is the generous default the create form preselects
export const NWC_DEFAULT_BUDGET: NwcBudget = {
  maxMsat: 10_000 * 1000,
  periodMs: NWC_PERIOD_DAY_MS,
};

// the enabled flag lives outside wallet settings on purpose: settings are
// part of the nostr-backup payload, and a restored device must not start
// answering payment requests before its holder opted in there
const NWC_ENABLED_KEY = 'sattle_nwc_enabled';
const readNwcEnabled = (): boolean => localStorage.getItem(NWC_ENABLED_KEY) === 'true';

// e2e test hook: a fake transport so the suite never touches a real relay.
// Set before enabling; production never calls this (exposed on window only
// in dev builds, at the bottom of this file).
let transportOverride: NwcTransport | null = null;
export const setNwcTransportForTests = (transport: NwcTransport | null): void => {
  transportOverride = transport;
};

const fingerprint = (pubkey: string): string =>
  pubkey.length > 18 ? `${pubkey.slice(0, 10)}…${pubkey.slice(-8)}` : pubkey;

const formatSats = (msat: number): string =>
  msatToSats(msat).toLocaleString(undefined, { maximumFractionDigits: 3 });

// The NWC control surface: the enabled setting, the reactive connection
// list, and the service lifecycle. The engine (lnurlcash/nwc.ts) stays
// framework-free; the service runs only while (enabled AND unlocked) - the
// wallet-service keys derive from the linking key, which only exists in
// memory then (foreground-only, see the nwc.ts façade header).
export const useNwcStore = defineStore('nwc', () => {
  const wallet = useWalletStore();
  const mints = useMintsStore();
  const activity = useActivityStore();

  const enabled = ref(readNwcEnabled());
  const connections = ref<NwcConnectionRecord[]>(readNwcConnections());
  const running = ref(false);
  // background failures (a rejected publish, a lost claim) have no caller
  // to throw to - the page surfaces them here
  const lastError = ref('');

  const refresh = (): void => {
    connections.value = readNwcConnections();
  };

  // ---- changeset application ----
  // the engine hands money-moving deltas here after an op ran: new notes to
  // persist, bearer ids to lock spent. Both go through the wallet store's
  // one entry points (persist-then-state); failures surface as lastError
  // rather than vanishing, since the engine already committed its side.
  const applyChangeset = (
    changeset: NwcChangeset,
    connection: NwcConnectionInfo,
    method: NwcMethod,
  ): void => {
    const client = fingerprint(connection.record.clientPubkey);
    if (method === 'pay_invoice') {
      // the melt's amount, from the bearers about to be locked spent
      const spentMsat = changeset.markSpent.reduce(
        (sum, id) => sum + (wallet.bearers.find((b) => b.id === id)?.amount ?? 0),
        0,
      );
      activity.log('nwc', `NWC client ${client} paid ${formatSats(spentMsat)} sats.`);
    }
    if (method === 'make_invoice' && changeset.add.length > 0) {
      const mintedMsat = changeset.add.reduce((sum, note) => sum + note.amount, 0);
      activity.log('nwc', `Received ${formatSats(mintedMsat)} sats via NWC client ${client}.`);
    }
    const onFailure = (error: unknown) => {
      lastError.value = error instanceof Error ? error.message : 'Applying an NWC change failed.';
    };
    if (changeset.add.length > 0) {
      void wallet.addBearers(changeset.add).catch(onFailure);
    }
    for (const id of changeset.markSpent) {
      void wallet.markSpent(id).catch(onFailure);
    }
  };

  // ---- service lifecycle ----
  // armed while (unlocked AND enabled) only; stop() closes every relay
  // subscription and drops the key-material closure. startToken invalidates
  // a start that is still in flight when stop (or a restart) lands.
  let service: NwcService | null = null;
  let startToken = 0;

  const start = async (): Promise<void> => {
    const token = ++startToken;
    lastError.value = '';
    try {
      const started = await startService(wallet.requireLinkingKey(), {
        // only spendable notes may back an NWC payment
        getBearers: () => wallet.unspentBearers,
        getDefaultMint: () => mints.defaultMint,
        applyChangeset,
        transport: transportOverride ?? undefined,
        onError: (error) => {
          lastError.value =
            error instanceof Error ? error.message : 'The NWC service hit an error.';
        },
      });
      if (token !== startToken) {
        // stopped (or restarted) while we were subscribing
        started.stop();
        return;
      }
      service = started;
      running.value = true;
    } catch (error) {
      if (token === startToken) {
        lastError.value =
          error instanceof Error ? error.message : 'The NWC service failed to start.';
      }
    }
  };

  const stop = (): void => {
    startToken++;
    service?.stop();
    service = null;
    running.value = false;
  };

  watch(
    () => [wallet.state, enabled.value] as const,
    ([state, on]) => {
      if (state === 'unlocked' && on) void start();
      else stop();
    },
    { immediate: true },
  );

  // the served set is a startup snapshot, so any change to the connection
  // records (create / budget edit / revoke) restarts the service to match
  const restartIfRunning = (): void => {
    if (!running.value) return;
    stop();
    if (wallet.state === 'unlocked' && enabled.value) void start();
  };

  // ---- settings ----
  const setEnabled = (value: boolean): void => {
    enabled.value = value;
    localStorage.setItem(NWC_ENABLED_KEY, String(value));
  };

  // ---- connection management ----
  // returns the created connection INCLUDING the one-time connection
  // string; the store keeps no copy of it (the client secret is never
  // persisted) - the caller must show it exactly once
  const create = (relays: string[], budget: NwcBudget): CreatedConnection => {
    const created = createConnection(wallet.requireLinkingKey(), { relays, budget });
    refresh();
    restartIfRunning();
    return created;
  };

  const updateBudget = (clientPubkey: string, budget: NwcBudget): void => {
    const record = readNwcConnections().find((r) => r.clientPubkey === clientPubkey);
    if (!record) return;
    persistNwcConnection({ ...record, budget });
    refresh();
    restartIfRunning();
  };

  const revoke = (clientPubkey: string): void => {
    removeNwcConnection(clientPubkey);
    refresh();
    restartIfRunning();
  };

  return {
    enabled,
    connections,
    running,
    lastError,
    setEnabled,
    create,
    updateBudget,
    revoke,
  };
});

// dev-only e2e hook: lets a spec inject a fake relay transport before
// enabling the service, so the suite opens no real WebSocket
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__sattleNwcTest = {
    setTransport: setNwcTransportForTests,
  };
}
