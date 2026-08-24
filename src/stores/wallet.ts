import { computed, onScopeDispose, ref } from 'vue';
import { defineStore } from 'pinia';

import {
  deriveBearerAesKey,
  savedKeyExists,
  savedKeyIsEncrypted,
  savedKeyOwnerId,
  clearSavedLinkingKey,
} from '@/lnurlcash/keys';
import {
  loadBearers,
  clearAllBearers,
  applyBackup,
  parseBackupFile,
  clearSettings,
} from '@/lnurlcash/storage';
import type { RestoreResult } from '@/lnurlcash/storage';
import { disableBiometricUnlock } from '@/capabilities/biometricUnlock';
import { restoreFromNostr as restoreFromNostrEngine } from '@/lnurlcash/nostrBackup';
import { useActivityStore } from './activity';
import { createWalletFunds } from './walletFunds';
import { createWalletIdleWatch } from './walletIdle';
import { createWalletAccess } from './walletAccess';
import { restoreHeldMintTrust } from './walletActivation';
import { startWalletOwnerMonitor } from './walletOwnerMonitor';
import { createWalletOwnerFence } from './walletOwnerFence';
import type { WalletState } from './walletOwnerFence';
import {
  clearOwnerAuthorizations,
  clearUnownedAuthorizations,
  createSeedInstaller,
  createWalletTransitionQueue,
  migrateProvenLegacyOwner,
  ownerOf,
  stopWalletNwcSession,
  WalletLifecycleError,
} from './walletLifecycle';

export { TrustedMintPostCommitError } from './walletFunds';

// 'none': no wallet on this device yet -> setup
// 'locked': linking key present but password-encrypted -> unlock
// 'unlocked': linking key (and thus the bearer AES key) in memory
export type { WalletState } from './walletOwnerFence';

// a plaintext-stored key also starts 'locked' - init() unlocks it
// immediately without a password, keeping a single code path for deriving
// the AES key and loading bearers
export const useWalletStore = defineStore('wallet', () => {
  const state = ref<WalletState>(savedKeyExists() ? 'locked' : 'none');
  const pubkey = ref<string | null>(null);
  const auxiliaryError = ref('');
  const lifecycleError = ref('');
  let aesKey: CryptoKey | null = null;
  // the linking key itself, only while unlocked - needed by backup/passkey
  // operations (nostrBackup derives the backup key from it, passkey
  // registration wraps it). Never exposed reactively; cleared on lock/forget
  let currentLinkingKey: Uint8Array | null = null;
  let lifecycleToken = 0;
  let acceptingOwnerWork = false;

  const lockWarningSecondsLeft = ref<number | null>(null);
  const runTransition = createWalletTransitionQueue({
    onStart: () => (lifecycleError.value = ''),
    onError: (error) => {
      lifecycleError.value = error instanceof Error ? error.message : 'Wallet transition failed.';
    },
  }).run;

  const encrypted = computed(() => savedKeyIsEncrypted());

  const ownerFence = createWalletOwnerFence({
    state: () => state.value,
    ownerId: () => pubkey.value,
    lifecycleToken: () => lifecycleToken,
    accepting: () => acceptingOwnerWork,
  });

  const clearRuntime = (): void => {
    aesKey = null;
    currentLinkingKey = null;
    pubkey.value = null;
    funds.clear();
    useActivityStore().unload();
  };

  // ends every captured fence and drops the reactive owner identity. Only
  // ever runs after accepted NWC work has drained (or failed to): an
  // operation past its irreversible melt must stay commit-capable until
  // then, and stop() rejects new requests the moment it is called, so no
  // post-lock work is accepted while the fence stays valid
  const invalidateLifecycle = (): void => {
    acceptingOwnerWork = false;
    lifecycleToken += 1;
    state.value = 'locked';
    pubkey.value = null;
  };

  const deactivateSession = async (): Promise<void> => {
    acceptingOwnerWork = false;
    stopOwnerChanges();
    idleWatch.stop();
    try {
      await stopWalletNwcSession();
    } finally {
      // even a rejected drain ends the session: 'locked' never holds key
      // material and no captured fence stays valid
      invalidateLifecycle();
      clearRuntime();
    }
  };

  let stopOwnerChanges = (): void => {};
  const observeOwnerChanges = (): void => {
    stopOwnerChanges();
    stopOwnerChanges = startWalletOwnerMonitor({
      snapshot: () => ({ token: lifecycleToken, state: state.value, ownerId: pubkey.value }),
      deactivate: deactivateSession,
      runTransition,
    });
  };
  onScopeDispose(() => stopOwnerChanges());

  const lock = (): Promise<void> =>
    runTransition(async () => {
      if (!savedKeyIsEncrypted()) return;
      await deactivateSession();
    });

  const idleWatch = createWalletIdleWatch({
    isEncrypted: savedKeyIsEncrypted,
    isUnlocked: () => state.value === 'unlocked',
    isLockWarningVisible: () => lockWarningSecondsLeft.value !== null,
    lock,
    setWarningSecondsLeft: (seconds) => {
      lockWarningSecondsLeft.value = seconds;
    },
  });

  const activate = async (linkingKey: Uint8Array, ownerWasMissing: boolean): Promise<void> => {
    auxiliaryError.value = '';
    await migrateProvenLegacyOwner(linkingKey, ownerWasMissing);
    const key = await deriveBearerAesKey(linkingKey);
    const loaded = await loadBearers(key);
    const activity = useActivityStore();
    await activity.loadFor(key);
    const ownerId = ownerOf(linkingKey);
    await restoreHeldMintTrust(loaded, ownerId, (message) => {
      auxiliaryError.value = message;
    });
    aesKey = key;
    currentLinkingKey = linkingKey;
    lifecycleToken += 1;
    observeOwnerChanges();
    pubkey.value = ownerId;
    funds.replace(loaded);
    acceptingOwnerWork = true;
    state.value = 'unlocked';
    idleWatch.start();
  };

  const teardownCurrentOwner = async (resetRegistry = false): Promise<void> => {
    const ownerId = savedKeyOwnerId() ?? pubkey.value;
    acceptingOwnerWork = false;
    stopOwnerChanges();
    idleWatch.stop();
    try {
      // the drain runs before the fence is invalidated and the runtime is
      // cleared so an in-flight fund-critical changeset can still commit
      // (its applyChangeset needs the live fence and key)
      await stopWalletNwcSession();
      invalidateLifecycle();
      clearRuntime();
      if (ownerId === null) await clearUnownedAuthorizations();
      else await clearOwnerAuthorizations(ownerId, resetRegistry);
      await disableBiometricUnlock();
      clearAllBearers();
      useActivityStore().unloadAndClear();
      clearSettings();
      clearSavedLinkingKey();
      state.value = 'none';
    } finally {
      // a failed teardown still ends the session: 'locked' must never hold
      // key material in memory, and no captured fence may stay usable
      if (state.value !== 'none') invalidateLifecycle();
      clearRuntime();
    }
  };

  const prepareInstallation = async (nextOwnerId: string): Promise<void> => {
    const installedOwner = savedKeyOwnerId() ?? pubkey.value;
    if (savedKeyExists() && installedOwner === nextOwnerId) {
      if (state.value === 'unlocked') await deactivateSession();
      return;
    }
    if (savedKeyExists() || state.value === 'unlocked') {
      await teardownCurrentOwner(true);
    }
    await clearUnownedAuthorizations();
  };

  const installSeed = createSeedInstaller({
    prepareInstallation,
    activate: (linkingKey) => activate(linkingKey, false),
  });

  const access = createWalletAccess({
    runTransition,
    installSeed,
    activate,
    canInit: () => state.value === 'locked',
  });

  const restoreFromBackup = (data: unknown): Promise<RestoreResult> =>
    runTransition(async () => {
      const backup = parseBackupFile(data);
      const hadSavedKey = savedKeyExists();
      const activeOwner = pubkey.value;
      const activeKey = state.value === 'unlocked' ? requireLinkingKey() : null;
      if (activeKey !== null) await deactivateSession();
      if (!hadSavedKey) await clearUnownedAuthorizations();
      const result = await applyBackup(backup, activeOwner ?? undefined);
      if (activeKey !== null) await activate(activeKey, false);
      else if (result.linkingKeyRestored) state.value = 'locked';
      return result;
    });

  const restoreFromNostr = (
    seedPhrase: string,
    relays: string[],
    password?: string,
  ): Promise<void> =>
    runTransition(() =>
      installSeed(seedPhrase, password, async (linkingKey) => {
        await restoreFromNostrEngine(linkingKey, relays);
      }),
    );

  const restoreCurrentFromNostr = (relays: string[]) =>
    runTransition(async () => {
      const linkingKey = requireLinkingKey();
      await deactivateSession();
      const result = await restoreFromNostrEngine(linkingKey, relays);
      await activate(linkingKey, false);
      return result;
    });

  // wipes this wallet from the device entirely - the linking key, every
  // bearer record, the activity log, and the non-secret registries that
  // would otherwise linger as a fingerprint of it. Not recoverable by
  // restoring the same seed afterward (the ciphertexts themselves are
  // gone); only a backup downloaded before this runs can bring the notes
  // back - the UI should prompt for one
  const forgetWallet = (): Promise<void> =>
    runTransition(() =>
      teardownCurrentOwner().catch((error) => {
        throw new WalletLifecycleError('forget', error);
      }),
    );

  const requireKey = (): CryptoKey => {
    if (!aesKey) throw new Error('Wallet is locked.');
    return aesKey;
  };

  // narrow accessor for the operations that need the key material itself
  // (nostr backup key derivation, passkey registration) - never reactive,
  // throws when locked, so callers can't accidentally hold a stale key
  const requireLinkingKey = (): Uint8Array => {
    if (!acceptingOwnerWork || !currentLinkingKey) throw new Error('Wallet is locked.');
    return currentLinkingKey;
  };

  const funds = createWalletFunds({
    requireKey,
    ownerId: () => pubkey.value ?? undefined,
    setAuxiliaryError: (message) => {
      auxiliaryError.value = message;
    },
  });

  return {
    state,
    pubkey,
    auxiliaryError,
    lifecycleError,
    encrypted,
    lockWarningSecondsLeft,
    ...funds.public,
    create: access.create,
    restoreFromSeed: access.restoreFromSeed,
    restoreFromBackup,
    restoreFromNostr,
    restoreCurrentFromNostr,
    unlock: access.unlock,
    unlockWithPasskey: access.unlockWithPasskey,
    unlockWithBiometric: access.unlockWithBiometric,
    lock,
    init: access.init,
    forgetWallet,
    postponeLock: idleWatch.postpone,
    requireLinkingKey,
    captureOwnerFence: ownerFence.capture,
  };
});
