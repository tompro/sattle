// Cross-tab storage events are hints only. Subscribers reread the live
// registry for their active owner rather than projecting event.newValue.

export const TRUSTED_MINTS_STORAGE_KEY = 'sattle_trusted_mints'

const listeners = new Set<() => void>()

export const notifyStoredTrustedMintsChange = (): void => {
  for (const listener of listeners) listener()
}

// Each subscription binds its own storage listener and removes exactly it on
// unsubscribe: no shared reference counting, so an abandoned subscriber can
// never keep another subscriber's window listener (or runtime) alive.
export const onStoredTrustedMintsChange = (listener: () => void): (() => void) => {
  listeners.add(listener)
  const target = typeof window === 'undefined' ? null : window
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== TRUSTED_MINTS_STORAGE_KEY && event.key !== null) return
    listener()
  }
  target?.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    target?.removeEventListener('storage', onStorage)
  }
}
