import { computed, onScopeDispose, ref, watch } from 'vue';
import { defineStore } from 'pinia';

import type { TrustedMint, TrustedMintNodeInfo, TrustKeyResult } from '@/lnurlcash/trustedMints';
import {
  PUBLIC_MINTS,
  readTrustedMints,
  onTrustedMintsChange,
  addTrustedMint,
  lockTrustedMint,
  confirmTrustedMintRekey,
  dismissTrustedMintRekey,
  removeTrustedMint,
  cacheTrustedMintNodeInfo,
  isMintTrusted,
  getTrustedMintPubkey,
} from '@/lnurlcash/trustedMints';
import { loadSettings, persistSettings } from '@/lnurlcash/storage';
import { useWalletStore } from './wallet';

// The trusted-mint registry as reactive state. The domain logic (pinning,
// rekey staging, backup merge rules) lives framework-free in
// src/lnurlcash/trustedMints.ts - this store mirrors it for the UI and
// exposes the actions. A mint advertising a NEW signing key is always
// staged for review (pendingRekeys), never auto-applied: a silently
// rotated key would defeat the entire pinning model.
export const useMintsStore = defineStore('mints', () => {
  const wallet = useWalletStore();
  const mints = ref<TrustedMint[]>([]);
  const activeOwner = (): string | null => (wallet.state === 'unlocked' ? wallet.pubkey : null);
  let stopTrustedMintsChanges: (() => void) | null = null;
  watch(
    () => [wallet.state, wallet.pubkey] as const,
    () => {
      stopTrustedMintsChanges?.();
      stopTrustedMintsChanges = null;
      const ownerId = activeOwner();
      if (ownerId === null) {
        mints.value = [];
        return;
      }
      mints.value = readTrustedMints(ownerId);
      stopTrustedMintsChanges = onTrustedMintsChange(() => {
        if (activeOwner() !== ownerId) return;
        mints.value = readTrustedMints(ownerId);
      });
    },
    { immediate: true, flush: 'sync' },
  );
  onScopeDispose(() => stopTrustedMintsChanges?.());

  const requireOwner = (): string => {
    const ownerId = activeOwner();
    if (ownerId === null) throw new Error('Wallet is locked.');
    return ownerId;
  };

  const isTrusted = (server: string): boolean => {
    const ownerId = activeOwner();
    return ownerId === null ? false : isMintTrusted(server, ownerId);
  };

  const trustedPubkey = (server: string): string | null => {
    const ownerId = activeOwner();
    return ownerId === null ? null : getTrustedMintPubkey(server, ownerId);
  };

  // mints with a staged rekey awaiting holder review - the UI should
  // surface these loudly
  const pendingRekeys = computed(() => mints.value.filter((m) => m.pendingMintPubkey));

  // ---- default-mint selection (onboarding quick start) ----
  const defaultMint = ref<string | null>(loadSettings().defaultMint ?? null);
  const setDefaultMint = (server: string | null): void => {
    defaultMint.value = server;
    const settings = loadSettings();
    if (server === null) {
      persistSettings({ ...settings, defaultMint: undefined });
    } else {
      persistSettings({ ...settings, defaultMint: server });
    }
  };

  // manual add from the mints settings, or a user-confirmed first
  // encounter - validates and throws on junk input
  const trust = (
    server: string,
    mintPubkey: string,
    nodeInfo?: TrustedMintNodeInfo,
  ): Promise<TrustKeyResult> =>
    addTrustedMint(server, mintPubkey, {
      ownerId: requireOwner(),
      nodeInfo,
    });

  // the silent path: this wallet holds (or just came to hold) a bearer from
  // this server - trust follows holding funds, never asks, and only ever
  // STAGES a differing advertised key
  const lockFromBearer = (server: string, mintPubkey: string): Promise<TrustKeyResult> =>
    lockTrustedMint(server, mintPubkey, requireOwner());

  const confirmRekey = (server: string): Promise<void> =>
    confirmTrustedMintRekey(server, requireOwner());
  const dismissRekey = (server: string): Promise<void> =>
    dismissTrustedMintRekey(server, requireOwner());

  // throws for a mint locked by a held bearer
  const remove = (server: string): Promise<void> => removeTrustedMint(server, requireOwner());

  const cacheNodeInfo = (server: string, nodeInfo: TrustedMintNodeInfo): Promise<void> =>
    cacheTrustedMintNodeInfo(server, nodeInfo, requireOwner());

  return {
    mints,
    pendingRekeys,
    defaultMint,
    setDefaultMint,
    PUBLIC_MINTS,
    trust,
    lockFromBearer,
    confirmRekey,
    dismissRekey,
    remove,
    cacheNodeInfo,
    isTrusted,
    trustedPubkey,
  };
});
