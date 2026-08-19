// Shared note types for the protocol core. In lnurl-wallet these lived in
// storage.ts (Bearer) and WalletContext.tsx (NewBearer); here they are
// extracted framework-free so receive.ts doesn't pull in app state modules.

// One bearer note held by this wallet - the decrypted, in-memory shape.
// `url` is the note's withdraw LNURL with the secret as its k1 param (so it
// IS the asset); the displayable bech32/lnurlw:// forms are re-encoded from
// it on demand.
export type Bearer = {
  id: string
  url: string
  callback: string // the mutating callback from the withdrawRequest JSON, '' until first verified
  amount: number // msat, last known (maxWithdrawable) - refreshed on demand
  verified: boolean // false while the issuing service hasn't confirmed the note yet
  // the issuing service's signing pubkey, cached once seen (withdrawRequest/
  // payRequest's optional mintPubkey) - lets a note's ?sig= be checked
  // offline against it without a network round trip
  mintPubkey?: string
  // a local-only lock, not a server-verified state: true once this wallet
  // has melted/handed over the note, or the holder marked it manually. It
  // just disables further mutating actions here so this copy can't be
  // reused by accident - it says nothing about whether the service has
  // actually burned it yet
  spent?: boolean
  // manual display order within its mint group - absent means "never
  // manually placed", which sorts by -createdAt instead, i.e. newest first
  sortIndex?: number
  // a free-text note the holder can attach for their own reference (e.g.
  // "rent", "gift for Alex") - purely local, never sent anywhere, no
  // protocol meaning at all
  label?: string
  // present if this note's secret lives on a paired LNURLvault device,
  // never in this browser's storage - the device's own note id. When set,
  // `url` never carries a real k1 (see lnurlcash.ts's withoutK1) - it's a
  // blank mirror, kept only so this bearer displays like any other
  // (amount/host/label/state)
  deviceId?: string
  createdAt: number
  updatedAt: number
}

export type NewBearer = {
  url: string
  callback: string
  amount: number
  verified: boolean
  mintPubkey?: string
  deviceId?: string
}
