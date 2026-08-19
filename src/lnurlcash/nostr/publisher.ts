// The debounced publisher the stores wire to their change events: rapid
// edits (a mint plus a receive plus a reorder) collapse into one publish
// of the final state. Trailing-edge debounce with in-flight coalescing.

import type {BackupPartPayload} from './events'

export type BackupPublisher = {
  // record that local state changed - the latest snapshot wins, and only
  // one publish fires per quiet window no matter how many changes landed
  schedule: (parts: Partial<BackupPartPayload>) => void
  // publish any pending snapshot immediately (app backgrounding, logout)
  flush: () => Promise<void>
  // drop any pending snapshot without publishing
  cancel: () => void
}

export type BackupPublisherOptions = {
  publish: (parts: Partial<BackupPartPayload>) => Promise<void>
  delayMs: number
  // a debounced publish has no caller to throw to - errors surface here;
  // the next scheduled change retries
  onError?: (error: unknown) => void
}

export const createBackupPublisher = (
  options: BackupPublisherOptions
): BackupPublisher => {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: Partial<BackupPartPayload> | null = null
  let running: Promise<void> | null = null

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const drain = async (): Promise<void> => {
    // a change can land mid-publish - keep looping until the newest
    // snapshot is the one that's out
    while (pending !== null) {
      const snapshot = pending
      pending = null
      try {
        await options.publish(snapshot)
      } catch (error) {
        options.onError?.(error)
      }
    }
  }

  const fire = (): Promise<void> => {
    clearTimer()
    // an in-flight drain picks up anything pending itself - a second drain
    // would double-publish the same snapshot
    running ??= drain().finally(() => {
      running = null
    })
    return running
  }

  return {
    schedule: parts => {
      pending = parts
      clearTimer()
      timer = setTimeout(() => void fire(), options.delayMs)
    },
    flush: fire,
    cancel: () => {
      clearTimer()
      pending = null
    }
  }
}
