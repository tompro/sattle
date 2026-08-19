// Wallet settings - plaintext, nothing secret (a default mint choice, a
// fiat display unit). Flat optional fields rather than a versioned
// envelope: absent keys just mean "never set".

export type WalletSettings = {
  defaultMint?: string
  // nostr backup (see nostrBackup.ts): off unless the holder turns it on;
  // relays are only persisted once edited - absent means the UI's defaults
  nostrBackupEnabled?: boolean
  nostrBackupRelays?: string[]
}

const SETTINGS_STORAGE_KEY = 'sattle_settings'

export const loadSettings = (): WalletSettings => {
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const s = parsed as Record<string, unknown>
    return {
      defaultMint:
        typeof s.defaultMint === 'string' ? s.defaultMint : undefined,
      nostrBackupEnabled:
        typeof s.nostrBackupEnabled === 'boolean'
          ? s.nostrBackupEnabled
          : undefined,
      nostrBackupRelays: Array.isArray(s.nostrBackupRelays)
        ? s.nostrBackupRelays.filter((r): r is string => typeof r === 'string')
        : undefined
    }
  } catch {
    return {}
  }
}

export const persistSettings = (settings: WalletSettings): void => {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
}

export const clearSettings = (): void => {
  localStorage.removeItem(SETTINGS_STORAGE_KEY)
}
