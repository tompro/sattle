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
  readNwcEnabled,
  readNwcConnections,
  removeNwcConnection,
  startService,
  writeNwcEnabled,
} from '@/lnurlcash/nwc';
import { linkingPubKeyHex } from '@/lnurlcash/keys';
import { msatToSats } from '@/lnurlcash/units';
import { TrustedMintPostCommitError, useWalletStore } from './wallet';
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

// e2e test hook: a fake transport so the suite never touches a real relay.
// Set before enabling; production never calls this (exposed on window only
// in dev builds, at the bottom of this file).
let transportOverride: NwcTransport | null = null;
export const setNwcTransportForTests = (transport: NwcTransport | null): void => {
  transportOverride = transport;
};

declare global {
  interface Window {
    __sattleNwcTest?: {
      readonly setTransport: typeof setNwcTransportForTests;
    };
  }
}

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

  const enabled = ref(false);
  const connections = ref<NwcConnectionRecord[]>([]);
  const running = ref(false);
  // background failures (a rejected publish, a lost claim) have no caller
  // to throw to - the page surfaces them here
  const lastError = ref('');

  const ownerFromWallet = (): string => linkingPubKeyHex(wallet.requireLinkingKey());

  const refresh = (ownerId: string = ownerFromWallet()): void => {
    connections.value = readNwcConnections(ownerId);
  };

  // ---- changeset application ----
  // the engine hands money-moving deltas here after an op ran: new notes to
  // persist, bearer ids to lock spent. Both go through the wallet store's
  // one entry points (persist-then-state) and are awaited: the engine holds
  // its success answer until this resolves, so a failure rejects back into
  // the engine's onError (surfaced as lastError) instead of a false success.
  const applyChangeset = async (
    changeset: NwcChangeset,
    connection: NwcConnectionInfo,
    method: NwcMethod,
    ownerFence: () => void,
  ): Promise<void> => {
    const client = fingerprint(connection.record.clientPubkey);
    try {
      await wallet.applyChangeset(changeset, ownerFence);
    } catch (error) {
      if (!(error instanceof TrustedMintPostCommitError)) throw error;
      lastError.value = error.message;
    }
    if (method === 'pay_invoice') {
      const spentMsat = changeset.markSpent.reduce(
        (sum, id) => sum + (wallet.bearers.find((b) => b.id === id)?.amount ?? 0),
        0,
      );
      await activity.log(
        'nwc',
        `NWC client ${client} paid ${formatSats(spentMsat)} sats.`,
        (error) => {
          lastError.value = error.message;
        },
      );
    }
    if (method === 'make_invoice' && changeset.add.length > 0) {
      const mintedMsat = changeset.add.reduce((sum, note) => sum + note.amount, 0);
      await activity.log(
        'nwc',
        `Received ${formatSats(mintedMsat)} sats via NWC client ${client}.`,
        (error) => {
          lastError.value = error.message;
        },
      );
    }
  };

  // ---- service lifecycle ----
  // armed while (unlocked AND enabled) only; stop() closes every relay
  // subscription and drops the key-material closure. startToken invalidates
  // a start that is still in flight when stop (or a restart) lands.
  let service: NwcService | null = null;
  let startToken = 0;
  const pendingStarts = new Set<Promise<void>>();
  let stopping: Promise<void> = Promise.resolve();
  let pendingStop: Promise<void> | null = null;

  const startNow = async (token: number): Promise<void> => {
    await stopping;
    if (token !== startToken || wallet.state !== 'unlocked' || !enabled.value) return;
    lastError.value = '';
    try {
      const ownerFence = wallet.captureOwnerFence();
      const started = await startService(wallet.requireLinkingKey(), {
        // only spendable notes may back an NWC payment
        getBearers: () => wallet.unspentBearers,
        getDefaultMint: () => mints.defaultMint,
        assertCurrentOwner: ownerFence,
        applyChangeset,
        transport: transportOverride ?? undefined,
        onError: (error) => {
          lastError.value =
            error instanceof Error ? error.message : 'The NWC service hit an error.';
        },
      });
      if (token !== startToken) {
        // stopped (or restarted) while we were subscribing
        await started.stop();
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

  const start = (): Promise<void> => {
    pendingStop = null;
    const token = ++startToken;
    const operation = startNow(token);
    pendingStarts.add(operation);
    void operation.then(
      () => pendingStarts.delete(operation),
      () => pendingStarts.delete(operation),
    );
    return operation;
  };

  const stop = (): Promise<void> => {
    if (service === null && pendingStarts.size === 0 && pendingStop !== null) {
      const result = pendingStop;
      pendingStop = null;
      return result;
    }
    startToken += 1;
    const active = service;
    service = null;
    running.value = false;
    const priorStop = stopping;
    const activeStop = active?.stop() ?? Promise.resolve();
    const completion = Promise.all([priorStop, activeStop, ...pendingStarts]).then(() => undefined);
    pendingStop = completion;
    stopping = completion.catch(() => undefined);
    return completion;
  };

  watch(
    () => wallet.state,
    (state) => {
      void stop()
        .then(() => {
          if (state !== 'unlocked') {
            enabled.value = false;
            connections.value = [];
            return;
          }
          const ownerId = ownerFromWallet();
          refresh(ownerId);
          enabled.value = readNwcEnabled(ownerId);
          if (enabled.value) return start();
        })
        .catch((error: unknown) => {
          lastError.value =
            error instanceof Error ? error.message : 'The NWC service failed to stop.';
        });
    },
    { immediate: true },
  );

  // the served set is a startup snapshot, so any change to the connection
  // records (create / budget edit / revoke) restarts the service to match
  const restartIfRunning = async (): Promise<void> => {
    if (!running.value) return;
    await stop();
    if (wallet.state === 'unlocked' && enabled.value) await start();
  };

  // ---- settings ----
  const setEnabled = async (value: boolean): Promise<void> => {
    const ownerId = ownerFromWallet();
    writeNwcEnabled(ownerId, value);
    enabled.value = value;
    if (value) await start();
    else await stop();
  };

  // ---- connection management ----
  // returns the created connection INCLUDING the one-time connection
  // string; the store keeps no copy of it (the client secret is never
  // persisted) - the caller must show it exactly once
  const create = (relays: string[], budget: NwcBudget): CreatedConnection => {
    const created = createConnection(wallet.requireLinkingKey(), { relays, budget });
    refresh();
    void restartIfRunning();
    return created;
  };

  const updateBudget = (clientPubkey: string, budget: NwcBudget): void => {
    const ownerId = ownerFromWallet();
    const record = readNwcConnections(ownerId).find((r) => r.clientPubkey === clientPubkey);
    if (!record) return;
    persistNwcConnection(ownerId, { ...record, budget });
    refresh(ownerId);
    void restartIfRunning();
  };

  const revoke = (clientPubkey: string): void => {
    const ownerId = ownerFromWallet();
    removeNwcConnection(ownerId, clientPubkey);
    refresh(ownerId);
    void restartIfRunning();
  };

  return {
    enabled,
    connections,
    running,
    lastError,
    stop,
    setEnabled,
    create,
    updateBudget,
    revoke,
  };
});

// dev-only e2e hook: lets a spec inject a fake relay transport before
// enabling the service, so the suite opens no real WebSocket
if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__sattleNwcTest = {
    setTransport: setNwcTransportForTests,
  };
}
