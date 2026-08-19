import {computed, ref} from 'vue'
import {defineStore} from 'pinia'
import {serverOf} from 'lnurlcash-kit'

import {
  deriveWalletLinkingKey,
  deriveBearerAesKey,
  saveLinkingKey,
  savedKeyExists,
  savedKeyIsEncrypted,
  getPlainLinkingKey,
  decryptSavedLinkingKey,
  clearSavedLinkingKey,
  generateSeedPhrase,
  isValidSeedPhrase,
  linkingPubKeyHex
} from '@/lnurlcash/keys'
import type {Bearer, NewBearer} from '@/lnurlcash/types'
import {
  loadBearers,
  persistBearer,
  deleteBearerRecord,
  clearAllBearers,
  newBearerId,
  mergeBearers
} from '@/lnurlcash/storage'
import {
  grandfatherTrustedMint,
  lockTrustedMint,
  clearTrustedMints
} from '@/lnurlcash/trustedMints'
import {clearSettings} from '@/lnurlcash/storage'
import {unlockWithPasskey as unlockWithPasskeyEngine} from '@/lnurlcash/passkeys'
import {msatToSats} from '@/lnurlcash/units'
import {useActivityStore} from './activity'

// 'none': no wallet on this device yet -> setup
// 'locked': linking key present but password-encrypted -> unlock
// 'unlocked': linking key (and thus the bearer AES key) in memory
export type WalletState = 'none' | 'locked' | 'unlocked'

// idle-timeout auto-lock: only meaningful for a password-encrypted key (see
// lock(), which no-ops otherwise) - 5 minutes with no activity anywhere in
// the tab locks the wallet. lockWarningSecondsLeft goes non-null 30s ahead
// of that so the UI can warn, and postponeLock() is the "stay unlocked"
// hook it offers.
const AUTO_LOCK_MS = 5 * 60 * 1000
const LOCK_WARNING_MS = 30 * 1000

// a plaintext-stored key also starts 'locked' - init() unlocks it
// immediately without a password, keeping a single code path for deriving
// the AES key and loading bearers
const initialState = (): WalletState => (savedKeyExists() ? 'locked' : 'none')

export const useWalletStore = defineStore('wallet', () => {
  const state = ref<WalletState>(initialState())
  const bearers = ref<Bearer[]>([])
  const pubkey = ref<string | null>(null)
  let aesKey: CryptoKey | null = null
  // the linking key itself, only while unlocked - needed by backup/passkey
  // operations (nostrBackup derives the backup key from it, passkey
  // registration wraps it). Never exposed reactively; cleared on lock/forget
  let currentLinkingKey: Uint8Array | null = null

  // ---- idle auto-lock bookkeeping ----
  let lastActivity = Date.now()
  let idleTimer: ReturnType<typeof setInterval> | null = null
  const lockWarningSecondsLeft = ref<number | null>(null)

  const encrypted = computed(() => savedKeyIsEncrypted())

  // ---- balances: protocol layer is msat; sats are a display helper ----
  const unspentBearers = computed(() => bearers.value.filter(b => !b.spent))
  const balanceMsat = computed(() =>
    unspentBearers.value.reduce((sum, b) => sum + b.amount, 0)
  )
  const balanceSats = computed(() => msatToSats(balanceMsat.value))
  const balanceByMintMsat = computed(() => {
    const byMint = new Map<string, number>()
    for (const b of unspentBearers.value) {
      const server = serverOf(b.url)
      byMint.set(server, (byMint.get(server) ?? 0) + b.amount)
    }
    return byMint
  })
  const balanceByMintSats = computed(() => {
    const byMint = new Map<string, number>()
    for (const [server, msat] of balanceByMintMsat.value) {
      byMint.set(server, msatToSats(msat))
    }
    return byMint
  })

  const stopIdleWatch = () => {
    if (idleTimer) clearInterval(idleTimer)
    idleTimer = null
    lockWarningSecondsLeft.value = null
  }

  const lock = () => {
    // only meaningful for a password-encrypted key - a plaintext one would
    // just auto-unlock again, so the UI only offers Lock when encrypted
    if (!savedKeyIsEncrypted()) return
    aesKey = null
    currentLinkingKey = null
    pubkey.value = null
    bearers.value = []
    useActivityStore().unload()
    stopIdleWatch()
    state.value = 'locked'
  }

  // any real interaction restarts the 5-minute clock and clears the
  // warning - the UI's "Stay unlocked" button calls this
  const postponeLock = () => {
    lastActivity = Date.now()
    lockWarningSecondsLeft.value = null
  }

  // ticks once a second while unlocked and encrypted (the only state
  // auto-lock applies to), comparing wall-clock time against lastActivity
  // rather than relying on a single setTimeout, since a backgrounded tab
  // throttles timers but Date.now() still reflects real elapsed time
  // whenever this next gets to run
  const startIdleWatch = () => {
    stopIdleWatch()
    if (typeof window === 'undefined' || !savedKeyIsEncrypted()) return
    lastActivity = Date.now()
    const registerActivity = () => {
      // once the warning is up, passive activity is deliberately ignored -
      // only postponeLock() dismisses it, so the "stay unlocked" button
      // can't vanish out from under the pointer before the click lands
      if (state.value === 'unlocked' && lockWarningSecondsLeft.value === null) {
        lastActivity = Date.now()
      }
    }
    for (const event of ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll']) {
      window.addEventListener(event, registerActivity, {passive: true})
    }
    idleTimer = setInterval(() => {
      if (state.value !== 'unlocked') return
      const elapsed = Date.now() - lastActivity
      if (elapsed >= AUTO_LOCK_MS) {
        lock()
      } else if (elapsed >= AUTO_LOCK_MS - LOCK_WARNING_MS) {
        lockWarningSecondsLeft.value = Math.ceil((AUTO_LOCK_MS - elapsed) / 1000)
      }
    }, 1000)
  }

  const activate = async (linkingKey: Uint8Array) => {
    const key = await deriveBearerAesKey(linkingKey)
    aesKey = key
    currentLinkingKey = linkingKey
    pubkey.value = linkingPubKeyHex(linkingKey)
    const loaded = await loadBearers(key)
    bearers.value = loaded
    const activity = useActivityStore()
    await activity.loadFor(key)
    // grandfather in every mint already backing a held bearer as trusted -
    // holding funds there already implied trusting it. Storage-sourced
    // claims only, though: grandfathering never locks and marks new pins
    // unconfirmed - both are (re-)earned by live responses during actual
    // bearer operations
    for (const bearer of loaded) {
      if (bearer.mintPubkey) {
        grandfatherTrustedMint(serverOf(bearer.url), bearer.mintPubkey)
      }
    }
    state.value = 'unlocked'
    startIdleWatch()
  }

  // generates a fresh seed phrase, derives and saves the linking key, and
  // unlocks. The phrase is returned exactly once - it is never stored, so
  // the caller MUST show it to the holder before letting them move on.
  const create = async (password?: string): Promise<string> => {
    const phrase = generateSeedPhrase()
    await restoreFromSeed(phrase, password)
    return phrase
  }

  const restoreFromSeed = async (
    seedPhrase: string,
    password?: string
  ): Promise<void> => {
    if (!isValidSeedPhrase(seedPhrase)) {
      throw new Error('Not a valid seed phrase.')
    }
    const linkingKey = deriveWalletLinkingKey(seedPhrase)
    await saveLinkingKey(linkingKey, password)
    await activate(linkingKey)
  }

  const unlock = async (password?: string): Promise<void> => {
    const linkingKey = savedKeyIsEncrypted()
      ? await decryptSavedLinkingKey(password || '')
      : getPlainLinkingKey()
    if (!linkingKey) throw new Error('No wallet on this device.')
    await activate(linkingKey)
  }

  // passkey unlock (passkeys.ts): the ceremony unwraps the SAME linking key
  // the password path protects, so activation is identical either way
  const unlockWithPasskey = async (): Promise<void> => {
    await activate(await unlockWithPasskeyEngine())
  }

  // app-start entry point (boot/wallet.ts): a plaintext-stored key unlocks
  // without a password; an encrypted one waits on the unlock screen
  const init = async (): Promise<void> => {
    if (state.value === 'locked' && !savedKeyIsEncrypted()) {
      await unlock()
    }
  }

  // wipes this wallet from the device entirely - the linking key, every
  // bearer record, the activity log, and the non-secret registries that
  // would otherwise linger as a fingerprint of it. Not recoverable by
  // restoring the same seed afterward (the ciphertexts themselves are
  // gone); only a backup downloaded before this runs can bring the notes
  // back - the UI should prompt for one
  const forgetWallet = () => {
    clearSavedLinkingKey()
    clearAllBearers()
    clearTrustedMints()
    clearSettings()
    useActivityStore().unloadAndClear()
    aesKey = null
    currentLinkingKey = null
    pubkey.value = null
    bearers.value = []
    stopIdleWatch()
    state.value = 'none'
  }

  const requireKey = (): CryptoKey => {
    if (!aesKey) throw new Error('Wallet is locked.')
    return aesKey
  }

  // narrow accessor for the operations that need the key material itself
  // (nostr backup key derivation, passkey registration) - never reactive,
  // throws when locked, so callers can't accidentally hold a stale key
  const requireLinkingKey = (): Uint8Array => {
    if (!currentLinkingKey) throw new Error('Wallet is locked.')
    return currentLinkingKey
  }

  // the one entry point for new notes (minted, received, carved outputs):
  // persists first, then updates state. Holding a bearer from a mint
  // trusts it by default - this is the one path that never asks (see
  // trustedMints.ts); a DIFFERENT advertised key comes back as
  // 'rekey-pending' and is staged on the mints store for review, never
  // auto-applied.
  const addBearers = async (notes: NewBearer[]): Promise<Bearer[]> => {
    const now = Date.now()
    const added: Bearer[] = []
    for (const note of notes) {
      const bearer: Bearer = {
        id: newBearerId(),
        ...note,
        createdAt: now,
        updatedAt: now
      }
      await persistBearer(requireKey(), bearer)
      added.push(bearer)
    }
    bearers.value = [...added, ...bearers.value]
    for (const bearer of added) {
      if (bearer.mintPubkey) {
        lockTrustedMint(serverOf(bearer.url), bearer.mintPubkey)
      }
    }
    return added
  }

  const updateBearer = async (
    id: string,
    changes: Partial<Omit<Bearer, 'id'>>
  ): Promise<void> => {
    const current = bearers.value.find(b => b.id === id)
    if (!current) return
    const updated: Bearer = {...current, ...changes, updatedAt: Date.now()}
    await persistBearer(requireKey(), updated)
    bearers.value = bearers.value.map(b => (b.id === id ? updated : b))
    if (updated.mintPubkey) {
      lockTrustedMint(serverOf(updated.url), updated.mintPubkey)
    }
  }

  const markSpent = async (id: string, spent = true): Promise<void> => {
    await updateBearer(id, {spent})
  }

  const removeNote = async (id: string): Promise<void> => {
    bearers.value = bearers.value.filter(b => b.id !== id)
    await deleteBearerRecord(id)
  }

  // merges externally-produced bearers (a decrypted backup restore, later a
  // nostr restore) into the live list: union by note identity, spent-wins -
  // see storage.ts's mergeBearers. Persists every survivor.
  const mergeExternalBearers = async (incoming: Bearer[]): Promise<void> => {
    const merged = mergeBearers(bearers.value, incoming)
    for (const bearer of merged) {
      await persistBearer(requireKey(), bearer)
    }
    bearers.value = merged
  }

  const reloadBearers = async (): Promise<void> => {
    bearers.value = await loadBearers(requireKey())
  }

  return {
    state,
    bearers,
    pubkey,
    encrypted,
    lockWarningSecondsLeft,
    balanceMsat,
    balanceSats,
    balanceByMintMsat,
    balanceByMintSats,
    unspentBearers,
    create,
    restoreFromSeed,
    unlock,
    unlockWithPasskey,
    lock,
    init,
    forgetWallet,
    postponeLock,
    requireLinkingKey,
    addBearers,
    updateBearer,
    markSpent,
    removeNote,
    mergeExternalBearers,
    reloadBearers
  }
})
