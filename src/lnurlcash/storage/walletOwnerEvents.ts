// Storage events only wake an owning store to reread its saved-key marker.
// Their payload may be stale when writes arrive faster than delivery.

export const LINKING_KEY_STORAGE_KEY = 'sattle_linking_key'

// Each subscription binds its own storage listener and removes exactly it on
// unsubscribe: no shared reference counting, so an abandoned subscriber can
// never keep another subscriber's window listener (or runtime) alive.
export const onSavedKeyStorageChange = (listener: () => void): (() => void) => {
  const target = typeof window === 'undefined' ? null : window
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== LINKING_KEY_STORAGE_KEY && event.key !== null) return
    listener()
  }
  target?.addEventListener('storage', onStorage)
  return () => target?.removeEventListener('storage', onStorage)
}
