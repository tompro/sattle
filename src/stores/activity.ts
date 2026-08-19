import {ref} from 'vue'
import {defineStore} from 'pinia'

import type {ActivityEvent, ActivityKind} from '@/lnurlcash/storage'
import {
  loadActivity,
  persistActivityEvent,
  clearAllActivity,
  newActivityId,
  MAX_ACTIVITY_ENTRIES
} from '@/lnurlcash/storage'

// The activity log: append-only, encrypted at rest with the same
// bearer-AES key as the notes themselves. Loaded by the wallet store on
// unlock (loadFor) and dropped on lock (unload) - it never holds plaintext
// while the wallet is locked.
export const useActivityStore = defineStore('activity', () => {
  const events = ref<ActivityEvent[]>([])
  let aesKey: CryptoKey | null = null

  const loadFor = async (key: CryptoKey): Promise<void> => {
    aesKey = key
    events.value = await loadActivity(key)
  }

  const unload = (): void => {
    aesKey = null
    events.value = []
  }

  // both unload and wipe the stored log - part of forgetting a wallet
  const unloadAndClear = (): void => {
    clearAllActivity()
    unload()
  }

  // best-effort and silent on failure - a wallet action that already
  // succeeded (the note was split/melted/whatever) must never surface an
  // error just because the log entry for it couldn't be written
  const log = (kind: ActivityKind, message: string): void => {
    if (!aesKey) return
    const event: ActivityEvent = {
      id: newActivityId(),
      kind,
      message,
      createdAt: Date.now()
    }
    events.value = [event, ...events.value].slice(0, MAX_ACTIVITY_ENTRIES)
    persistActivityEvent(aesKey, event).catch(() => {
      // deliberately swallowed - see the comment above
    })
  }

  const clear = (): void => {
    clearAllActivity()
    events.value = []
  }

  return {events, loadFor, unload, unloadAndClear, log, clear}
})
