# PROJECT KNOWLEDGE BASE

**Generated:** 2026-08-20
**Commit:** 7841a13
**Branch:** main

## OVERVIEW

sattle — end-user PWA wallet for LNURLcash (LUD-25) Lightning bearer notes.
Quasar 2 / Vue 3 (`script setup` + TS) / Pinia / vue-i18n. Capacitor 8
Android wrapper lives in `android/`; the PWA is the canonical build.

## STRUCTURE

```
src/lnurlcash/    # protocol engine + storage, framework-free (own AGENTS.md)
src/stores/       # Pinia: wallet, mints, activity, nostrBackup, nwc
src/components/   # dialogs (send/, receive/), QrCode, QrScanner, UnlockForm
src/pages/        # IndexPage (main), Settings*, ManageMints, MoveFunds, Nwc,
                  # Backup, Security, Welcome (onboarding)
src/capabilities/ # ONLY place Capacitor plugins are imported
src/boot/         # wallet init, deeplinks
e2e/              # Playwright (own AGENTS.md)
```

## WHERE TO LOOK

| Task                | Location                                               | Notes                                          |
| ------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| Any fund movement   | `src/lnurlcash/ops/`                                   | engine returns changesets, never mutates state |
| Add a settings page | `src/pages/` + `router/routes.ts` + SettingsPage group | back-button header pattern                     |
| Native feature      | `src/capabilities/`                                    | never import plugins elsewhere                 |
| Change wallet state | stores call ops + `addBearers`/`markSpent`             | add fresh notes BEFORE marking spent           |
| Mint fee math       | `src/lnurlcash/fees.ts`                                | gross vs net direction matters                 |

## CODE MAP

| Module                     | Role                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `lnurlcash/ops.ts`         | façade: carve/mint/pay/receiveBearer/transfer                                                             |
| `lnurlcash/storage/`       | AES-GCM bearers+activity, owner-bound credentials and trusted mints, backup (merge entry point), settings |
| `lnurlcash/keys.ts`        | BIP39 + LUD-05 linking key; password wrap                                                                 |
| `lnurlcash/passkeys.ts`    | WebAuthn PRF wrap of the SAME linking key                                                                 |
| `lnurlcash/nostrBackup.ts` | kind-30078 NIP-44 backup + restore via applyBackup                                                        |
| `lnurlcash/nwc/`           | NIP-47 wallet service (per-connection budget)                                                             |
| `stores/wallet.ts`         | serialized owner lifecycle; state none/locked/unlocked; linking key in memory only while unlocked         |

## CONVENTIONS

- Commit style: semantic (`feat:`, `fix:`, `build:`, `ci:`, `test:`), English.
- Releases: release-please (`.github/workflows/release.yml`) — never bump
  versions or write changelog entries by hand; merge the release PR.
- Hash router; `BlankLayout` for /welcome (q-page needs a layout).
- Dark theme, `#002222` bg, mint `#55ffcc` primary; `sattle-card` surfaces.
- Quasar `Notify` plugin is enabled — use it for toasts.
- Brand assets: `src/assets/sattle-{wallet,text}.png` (raster; source SVGs
  live outside the repo).

## ANTI-PATTERNS (THIS PROJECT)

- NEVER mutate wallet state inside `src/lnurlcash/**` — engine is pure.
- NEVER auto-apply a mint's advertised new signing key — stage as pending rekey.
- NEVER log note URLs / k1 values.
- No type suppression (`as any`, `@ts-ignore`) anywhere.
- No new runtime deps without a recorded reason (nostr-tools is the bar).

## COMMANDS

```bash
npx quasar dev -m spa      # dev
npx vitest run             # unit (node env, mock mint)
npm run test:e2e           # playwright, system chromium (CHROMIUM_PATH)
npx vue-tsc --noEmit       # typecheck
npx quasar build -m pwa    # production build
npm run cap:sync           # build + cap sync android
```

## NOTES

- NixOS: use the flake dev shell (nodejs_22 + chromium for e2e).
  `sass-embedded` is aliased to pure-JS `sass` via npm overrides.
- `lnurlcash-kit@0.1.1` and `lnurlcash-conformance@0.1.1` are exact npm
  registry packages. Keep their manifest pins, registry tarball URLs, and lock
  integrity values intact.
- Credential and authorization records are bound to the canonical owner ID
  derived from the linking key. Ordinary writes require an exact match with the
  persisted saved-key owner. Ownerless legacy records migrate only after a
  proven unlock, never from a restored file claim or passkey-first attempt.
- Wallet create, unlock, lock, restore, and forget transitions are serialized.
  Forget locks first, drains NWC, clears runtime keys and owner namespaces,
  then removes the saved key only after biometric deletion succeeds.
- Storage events are wakeups, not authoritative payloads. Re-read matching
  storage on an event, including `key === null`, before converging state or
  invalidating a stale owner tab. Web Locks serialize supported browsers but
  do not make another tab's localStorage cache current; trusted mints reconcile
  through a durable IndexedDB commit mirror before success. `withStorageLock`
  falls back to local execution without a cross-tab guarantee.
- tsconfig deliberately relaxed (`exactOptionalPropertyTypes` etc. off) to
  keep the protocol core untouched; `src/lnurlcash` has an eslint override.
- Gitea remote dropped; origin = GitHub. Gitea mirror = pull-mirror on the
  Gitea side (no secrets needed).
