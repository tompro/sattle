# src/lnurlcash — protocol engine

Framework-free LNURLcash core: no Vue, no Pinia, no Quasar imports. Pinia
stores call these modules and apply returned changesets; UI never touches
lnurlcash-kit directly.

## FUND-CRITICAL INVARIANTS (non-negotiable)

- Rotate on every receive, and immediately after claiming a fresh mint.
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
storage/         # encrypted bearers + activity log, settings, backup,
                 # nwcConnections, passkeySlots; storage.ts is the façade
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
- Storage: localStorage keys `sattle_*`; strict shape validation on read,
  malformed entries dropped; read-modify-write under `withStorageLock`.
- Network: kit calls only; injectable transport/options so tests never
  touch the network. No WebSocket at import time (lazy `import()`).
- Every module header comment explains the WHY, including failure models.

## TESTS

`npx vitest run` — node environment, `*.test.ts` next to the modules.
Adversarial mock mint from lnurlcash-conformance via test-utils.
