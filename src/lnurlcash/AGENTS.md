# src/lnurlcash — protocol engine

Framework-free LNURLcash core: no Vue, no Pinia, no Quasar imports. Pinia
stores call these modules and apply returned changesets; UI never touches
lnurlcash-kit directly.

## FUND-CRITICAL INVARIANTS (non-negotiable)

- Rotate on every receive, and immediately after claiming a fresh mint
  from an UNNAMED mint (one that keys the note by the payment preimage).
  A NAMED mint (LUD-25 `comment`/`mintToHash`, required by lnurl-mint
  ≥ 0.4) credits the note to a wallet-chosen secret whose hash bound the
  quote; that secret never rode an invoice, so the claim needs no rotate.
  The claim poll itself is the placement proof: a mint that took the hash
  but credited the preimage is caught there and rescued through the
  quote's verify URL when one is served.
- A note's declared amount is a claim; the service's `maxWithdrawable` is
  authoritative.
- A melt's "OK" only means the payment is in flight — the verify URL (or
  the note becoming spendable again) is the real outcome.
- An ambiguous mutation NEVER loses fresh secrets: rescued into tracked
  notes, probed, or surfaced to the caller unverified.
- Definitive service answers (NoteSpentError / NoteUnknownError /
  PendingNoteError) always propagate distinctly — never papered over by an
  unverified fallback.

## STRUCTURE

```
ops.ts / ops/    # flows: carve (exact-amount), mint, pay, receiveBearer,
                 # transfer (inter-mint); ops.ts is the façade
storage/         # encrypted bearers + activity log, owner-bound NWC,
                 # passkey and trusted-mint records, settings, backup;
                 # storage.ts is the façade
keys.ts          # BIP39, LUD-05 linking key derivation, password wrap
passkeys.ts + passkeyWrap.ts   # WebAuthn PRF wrap (same linking key)
nostrBackup.ts + nostr/        # kind-30078 backup, NIP-44 self-encryption
nwc.ts + nwc/    # NIP-47 wallet service
fees.ts          # mint fee math (gross/net direction!) + cached quotes
trustedMints.ts  # key pinning, rekey staging, backup merge rules
test-utils.ts    # mock mint harness used by *.test.ts
```

## CONVENTIONS

- Style: NO semicolons, 2-space indent, single quotes, `{braced}` imports
  without inner spaces — deliberately different from the rest of the app
  (eslint override); keep the tested core diffable against its lineage.
- Storage: localStorage keys `sattle_*`; strict shape validation on read.
  Credential, NWC, passkey, and trusted-mint records belong to the canonical
  saved-key owner. Normal writes require that exact persisted owner; migration
  of ownerless legacy records has its own proof-gated API.
- Concurrency: read-modify-write uses `withStorageLock` where Web Locks are
  available, but lock handoff is not a localStorage visibility barrier. The
  trusted-mint repository reconciles from a durable IndexedDB commit mirror
  before one successful localStorage write and before resolving. Its fallback
  is local execution only, with no cross-tab serialization guarantee. Storage
  events are wakeups, so listeners re-read current storage instead of trusting
  `event.newValue`, including on clears.
- Lifecycle: wallet transitions serialize create, restore, unlock, lock, and
  forget. Activation completes proven-owner migration before exposing unlocked
  state. Forget locks, drains NWC, clears runtime and owner-bound state, then
  removes the saved key after biometric deletion succeeds.
- Network: kit calls only; injectable transport/options so tests never
  touch the network. No WebSocket at import time (lazy `import()`).
- Every module header comment explains the WHY, including failure models.

## TESTS

`npx vitest run` — node environment, `*.test.ts` next to the modules.
Adversarial mock mint from lnurlcash-conformance via `ops.testHarness.ts`
(`conformance-mockmint.d.ts` augments its stale published declarations
with the comment-naming flags). The mock's `commentAllowed` option models
the named-mint generation; default options model the old one.
