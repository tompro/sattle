// allow: SIZE_OK — indivisible wallet lifecycle state machine and its public Pinia surface.
import { computed, onScopeDispose, ref } from 'vue';
import { defineStore } from 'pinia';
import { cashNodeFromHex } from 'lnurlcash-kit';

import {
  clearSavedLinkingKey,
  clearSavedWalletMaterial,
  deriveBearerAesKey,
  savedWalletMaterialExists,
  savedWalletMaterialIsEncrypted,
  savedWalletMaterialOwnerId,
  walletMaterialLinkingKey,
} from '@/lnurlcash/keys';
import type { WalletMaterialV2 } from '@/lnurlcash/keys';
import { walletMaterialOwnerId } from '@/lnurlcash/storage/storedSecret';
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
  resetUnsupportedLegacyWalletState,
  stopWalletNwcSession,
  WalletLifecycleError,
} from './walletLifecycle';

export { TrustedMintPostCommitError } from './walletFunds';

// 'none': no wallet on this device yet -> setup
// 'locked': wallet material present but password-encrypted -> unlock
// 'unlocked': the complete material (linking key + cash root) is in memory
export type { WalletState } from './walletOwnerFence';

// a plaintext-stored material record also starts 'locked' - init() unlocks
// it immediately without a password, keeping a single code path for deriving
// the AES key and loading bearers
export const useWalletStore = defineStore('wallet', () => {
  const state = ref<WalletState>(savedWalletMaterialExists() ? 'locked' : 'none');
  const pubkey = ref<string | null>(null);
  const auxiliaryError = ref('');
  const lifecycleError = ref('');
  let aesKey: CryptoKey | null = null;
  // the complete v2 wallet material, only while unlocked - the cash root
  // funds every BIP-32 secret derivation and the linking key inside it backs
  // backup/passkey operations (nostrBackup derives the backup key from it,
  // passkey and biometric enrollment wrap the whole value). Never exposed
  // reactively; cleared on lock/forget/failed activation
  let currentMaterial: WalletMaterialV2 | null = null;
  let lifecycleToken = 0;
  let acceptingOwnerWork = false;

  const lockWarningSecondsLeft = ref<number | null>(null);
  const runTransition = createWalletTransitionQueue({
    onStart: () => (lifecycleError.value = ''),
    onError: (error) => {
      lifecycleError.value = error instanceof Error ? error.message : 'Wallet transition failed.';
    },
  }).run;

  const encrypted = computed(() => savedWalletMaterialIsEncrypted());

  const ownerFence = createWalletOwnerFence({
    state: () => state.value,
    ownerId: () => pubkey.value,
    lifecycleToken: () => lifecycleToken,
    accepting: () => acceptingOwnerWork,
  });

  const clearRuntime = (): void => {
    aesKey = null;
    currentMaterial = null;
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
      if (!savedWalletMaterialIsEncrypted()) return;
      await deactivateSession();
    });

  const idleWatch = createWalletIdleWatch({
    isEncrypted: savedWalletMaterialIsEncrypted,
    isUnlocked: () => state.value === 'unlocked',
    isLockWarningVisible: () => lockWarningSecondsLeft.value !== null,
    lock,
    setWarningSecondsLeft: (seconds) => {
      lockWarningSecondsLeft.value = seconds;
    },
  });

  // Activation enters the unlocked state for exactly the saved material.
  // The owner monitor is subscribed BEFORE the first async gap and the saved
  // owner is re-read immediately before exposing 'unlocked': a replacement
  // that landed during deferred loading must fence this activation instead
  // of letting a stale owner through
  const activate = async (material: WalletMaterialV2, ownerWasMissing: boolean): Promise<void> => {
    auxiliaryError.value = '';
    const ownerId = walletMaterialOwnerId(material);
    observeOwnerChanges();
    try {
      await migrateProvenLegacyOwner(material, ownerWasMissing);
      if (savedWalletMaterialOwnerId() !== ownerId) {
        throw new WalletLifecycleError('activate', new Error('saved wallet changed'));
      }
      const key = await deriveBearerAesKey(walletMaterialLinkingKey(material));
      const loaded = await loadBearers(key);
      const activity = useActivityStore();
      await activity.loadFor(key);
      await restoreHeldMintTrust(loaded, ownerId, (message) => {
        auxiliaryError.value = message;
      });
      if (savedWalletMaterialOwnerId() !== ownerId) {
        throw new WalletLifecycleError('activate', new Error('saved wallet changed'));
      }
      aesKey = key;
      currentMaterial = material;
      lifecycleToken += 1;
      pubkey.value = ownerId;
      funds.replace(loaded);
      acceptingOwnerWork = true;
      state.value = 'unlocked';
      await funds.public.recoverPendingMints(ownerFence.capture());
      idleWatch.start();
    } catch (error) {
      stopOwnerChanges();
      acceptingOwnerWork = false;
      lifecycleToken += 1;
      pubkey.value = null;
      clearRuntime();
      // a failed activation is locked when a wallet record exists (retry via
      // unlock) and uninstalled when none does - never half-installed
      state.value = savedWalletMaterialExists() ? 'locked' : 'none';
      throw error;
    }
  };

  const teardownCurrentOwner = async (resetRegistry = false): Promise<void> => {
    const ownerId = savedWalletMaterialOwnerId() ?? pubkey.value;
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
      // invalidate the legacy saved-key entry too: old tabs watching it must
      // fence themselves, and the record is residue under the v2 lifecycle
      clearSavedLinkingKey();
      // the saved material goes last: a failure above leaves the complete
      // enrollment (and this record) in place for a safe retry
      clearSavedWalletMaterial();
      state.value = 'none';
    } finally {
      // a failed teardown still ends the session: 'locked' must never hold
      // key material in memory, and no captured fence may stay usable
      if (state.value !== 'none') invalidateLifecycle();
      clearRuntime();
    }
  };

  const prepareInstallation = async (nextOwnerId: string): Promise<void> => {
    // the install path re-runs the alpha reset, so a boot-time reset that
    // failed (e.g. native biometric deletion) is retried before any
    // successor is installed
    await resetUnsupportedLegacyWalletState();
    const installedOwner = savedWalletMaterialOwnerId() ?? pubkey.value;
    if (savedWalletMaterialExists() && installedOwner === nextOwnerId) {
      if (state.value === 'unlocked') await deactivateSession();
      return;
    }
    if (savedWalletMaterialExists() || state.value === 'unlocked') {
      await teardownCurrentOwner(true);
    }
    await clearUnownedAuthorizations();
  };

  const installSeed = createSeedInstaller({
    prepareInstallation,
    activate: (material) => activate(material, false),
  });

  const access = createWalletAccess({
    runTransition,
    installSeed,
    activate,
    canInit: () => state.value === 'locked',
    onResetError: (error) => {
      lifecycleError.value = error instanceof Error ? error.message : 'Wallet reset failed.';
    },
  });

  const restoreFromBackup = (data: unknown): Promise<RestoreResult> =>
    runTransition(async () => {
      const backup = parseBackupFile(data);
      const hadSavedMaterial = savedWalletMaterialExists();
      const activeOwner = pubkey.value;
      const activeMaterial = state.value === 'unlocked' ? requireWalletMaterial() : null;
      if (activeMaterial !== null) await deactivateSession();
      if (!hadSavedMaterial) await clearUnownedAuthorizations();
      const result = await applyBackup(backup, activeOwner ?? undefined);
      // a file-carried legacy linking key can never become v2 material (the
      // cash root is unrecoverable from it): the record applyBackup just
      // installed is residue here, and removing it keeps old tabs fenced
      clearSavedLinkingKey();
      if (activeMaterial !== null) await activate(activeMaterial, false);
      return result;
    });

  const restoreFromNostr = (
    seedPhrase: string,
    relays: string[],
    password?: string,
  ): Promise<void> =>
    runTransition(() =>
      installSeed(seedPhrase, password, async (material) => {
        await restoreFromNostrEngine(walletMaterialLinkingKey(material), relays);
      }),
    );

  const restoreCurrentFromNostr = (relays: string[]) =>
    runTransition(async () => {
      const material = requireWalletMaterial();
      await deactivateSession();
      const result = await restoreFromNostrEngine(walletMaterialLinkingKey(material), relays);
      await activate(material, false);
      return result;
    });

  // wipes this wallet from the device entirely - the wallet material, every
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
  const requireLinkingKey = (): Uint8Array => walletMaterialLinkingKey(requireWalletMaterial());

  // the complete material for the enrollment flows that wrap it (passkey,
  // biometric) - same access rules as requireLinkingKey
  const requireWalletMaterial = (): WalletMaterialV2 => {
    if (!acceptingOwnerWork || !currentMaterial) throw new Error('Wallet is locked.');
    return currentMaterial;
  };

  const funds = createWalletFunds({
    requireKey,
    requireCashRoot: () => cashNodeFromHex(requireWalletMaterial().cashRootHex),
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
    requireWalletMaterial,
    captureOwnerFence: ownerFence.capture,
  };
});
