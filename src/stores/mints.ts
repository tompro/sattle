import {computed, ref} from 'vue'
import {defineStore} from 'pinia'

import type {
  TrustedMint,
  TrustedMintNodeInfo,
  TrustKeyResult
} from '@/lnurlcash/trustedMints'
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
  getTrustedMintPubkey
} from '@/lnurlcash/trustedMints'
import {loadSettings, persistSettings} from '@/lnurlcash/storage'

// The trusted-mint registry as reactive state. The domain logic (pinning,
// rekey staging, backup merge rules) lives framework-free in
// src/lnurlcash/trustedMints.ts - this store mirrors it for the UI and
// exposes the actions. A mint advertising a NEW signing key is always
// staged for review (pendingRekeys), never auto-applied: a silently
// rotated key would defeat the entire pinning model.
export const useMintsStore = defineStore('mints', () => {
  const mints = ref<TrustedMint[]>(readTrustedMints())
  onTrustedMintsChange(updated => {
    mints.value = updated
  })

  // mints with a staged rekey awaiting holder review - the UI should
  // surface these loudly
  const pendingRekeys = computed(() =>
    mints.value.filter(m => m.pendingMintPubkey)
  )

  // ---- default-mint selection (onboarding quick start) ----
  const defaultMint = ref<string | null>(loadSettings().defaultMint ?? null)
  const setDefaultMint = (server: string | null): void => {
    defaultMint.value = server
    const settings = loadSettings()
    if (server === null) {
      persistSettings({...settings, defaultMint: undefined})
    } else {
      persistSettings({...settings, defaultMint: server})
    }
  }

  // manual add from the mints settings, or a user-confirmed first
  // encounter - validates and throws on junk input
  const trust = (
    server: string,
    mintPubkey: string,
    nodeInfo?: TrustedMintNodeInfo
  ): TrustKeyResult => addTrustedMint(server, mintPubkey, nodeInfo)

  // the silent path: this wallet holds (or just came to hold) a bearer from
  // this server - trust follows holding funds, never asks, and only ever
  // STAGES a differing advertised key
  const lockFromBearer = (server: string, mintPubkey: string): TrustKeyResult =>
    lockTrustedMint(server, mintPubkey)

  const confirmRekey = (server: string): void => confirmTrustedMintRekey(server)
  const dismissRekey = (server: string): void => dismissTrustedMintRekey(server)

  // throws for a mint locked by a held bearer
  const remove = (server: string): void => removeTrustedMint(server)

  const cacheNodeInfo = (server: string, nodeInfo: TrustedMintNodeInfo): void =>
    cacheTrustedMintNodeInfo(server, nodeInfo)

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
    isTrusted: isMintTrusted,
    trustedPubkey: getTrustedMintPubkey
  }
})
