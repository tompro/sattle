# e2e — Playwright suite

Browser-level tests against the real app. Run: `npm run test:e2e`
(`test:e2e:ui` for the UI mode).

## ENVIRONMENT

- System Chromium, never downloaded browsers: `CHROMIUM_PATH` env or
  `command -v chromium` fallback (flake dev shell provides both). CI
  installs Playwright's own chromium — the config only forces
  `executablePath` when a system browser exists.
- `webServer` boots `quasar dev -m spa --port 9333` (~15-25s ready),
  `reuseExistingServer` locally. serviceWorkers blocked.

## STRUCTURE

- `fixtures.ts` — extended test with the `mint` fixture (MintMocker),
  routes unrouted after each test.
- `helpers/MintMocker.ts` — `page.route` mocks on never-resolving
  `https://mint.test` / `https://mint2.test` origins. Responses must carry
  `Access-Control-Allow-Origin: *`. IMPORTANT: mirror the real protocol —
  `mintPubkey` is announced on the mint-address (`/.well-known/lnurlw/`)
  and note-info responses, NOT the payRequest (a too-generous mock once
  masked a real bug).
- `helpers/wallet.ts` — `createFreshWallet(page)`: drives onboarding UI to
  an unlocked 0-sat wallet.

## CONVENTIONS

- No real network, ever — every external call goes through a route mock.
- First-contact trust prompt: receiving a note with a `mintPubkey` opens
  the "New mint" dialog — specs must click through it.
- Toasts duplicate in-page text — scope assertions to `.q-page` or the
  dialog, never the raw text.
- Dev-only test hooks (e.g. `window.__sattleNwcTest`) exist for injecting
  fake transports; never available in production builds.
- WebAuthn ceremonies are NOT e2e-testable headless — assert the honest
  unsupported state instead.
- Known lint drift: `import()` type annotations trip
  `consistent-type-imports` (pre-existing; the dev checker only lints app
  code, so CI/e2e are unaffected).
