# Changelog

## [0.0.2](https://github.com/tompro/sattle/compare/sattle-v0.0.1...sattle-v0.0.2) (2026-08-20)


### Features

* backup and security settings pages, nostr restore onboarding, passkey unlock entry ([1920a00](https://github.com/tompro/sattle/commit/1920a00cd65651f057cc44f4e38d14f8353cfa09))
* capability layer for clipboard, share and deep links with tests ([f525b06](https://github.com/tompro/sattle/commit/f525b069664cc34fbac3c00f5101aaabd774fece))
* capacitor android platform project ([3f22534](https://github.com/tompro/sattle/commit/3f22534cf0f30f1a2bc1ab1aa645517e85a7949c))
* deep link routing for lightning and lnurl schemes plus association files ([229e9fc](https://github.com/tompro/sattle/commit/229e9fcf38addc843a81a4b57e1f70cec76f36fd))
* inter-mint transfer op with fee quote and ambiguity-safe outcomes ([142734b](https://github.com/tompro/sattle/commit/142734b903e932a36db2d0e62a4c66ceb9ee9fd6))
* manage mints and move funds settings pages ([f631c7c](https://github.com/tompro/sattle/commit/f631c7c264fe962b33ba2c8ea1cc3f8974cc6607))
* native biometric unlock via biometric-gated wrap of the linking key ([e59b722](https://github.com/tompro/sattle/commit/e59b722b5e9093e34b336f0cb0446e34383d4df7))
* nip-47 nwc wallet service engine with per-connection budgets ([33318a5](https://github.com/tompro/sattle/commit/33318a5150afd55b5580dd5a15052434aefde90f))
* nostr kind-30078 backup engine with nip-44 self-encryption and merge-on-restore ([7ecade3](https://github.com/tompro/sattle/commit/7ecade32eeb277d9bd6df734ddc76232f06bdee0))
* nwc connections settings page with one-time connection strings and service lifecycle ([5221127](https://github.com/tompro/sattle/commit/52211273b15e0eb503d5466a250f756a3ed3548a))
* pinia wallet, mints and activity stores with wallet boot ([fdd12dc](https://github.com/tompro/sattle/commit/fdd12dcc1eff116bf335673744e519975b3f3ef2))
* reusable mint fee math with cached quotes, fee-aware Max in move funds ([f4b9377](https://github.com/tompro/sattle/commit/f4b9377d17a2736c429a7272fac8b1742098a60d))
* sattle branding, logo assets and generated app icons ([48e4c84](https://github.com/tompro/sattle/commit/48e4c840929e68cd1740669379b7ed5ed37d32b0))
* send/receive dialogs, qr scanner, history and unlock components ([48fffff](https://github.com/tompro/sattle/commit/48fffff02a17c303dbf807de140d56af26cae88f))
* wallet operations engine and encrypted storage with tests ([1c9e716](https://github.com/tompro/sattle/commit/1c9e7165e4269996891e9112951c3ec75a6e6898))
* wallet screens, branded header layout and mobile-first main view ([1fe1453](https://github.com/tompro/sattle/commit/1fe1453745f3ab9132decb984242b586588c3178))
* webauthn prf passkey unlock engine as alternative wrap of the linking key ([7db3408](https://github.com/tompro/sattle/commit/7db34083e6345fb5acbf31722736d24fa0441815))


### Bug Fixes

* bind window.fetch at boot so lnurlcash-kit transport works in browsers ([1839700](https://github.com/tompro/sattle/commit/18397002150eca483ba1f00951715e30fbacd792))
* discover a mint's signing key from the mint-address endpoint, not the payRequest ([3926121](https://github.com/tompro/sattle/commit/39261212cf1b27626b2f33de045081a9adfc2592))

## Changelog

All notable changes to sattle are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
releases are automated with
[release-please](https://github.com/googleapis/release-please) from
conventional commits: it maintains a release PR that bumps `package.json`
and updates this file; merging that PR tags `vX.Y.Z` and creates the
GitHub release.
