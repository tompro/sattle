# Changelog

## [0.0.6](https://github.com/tompro/sattle/compare/sattle-v0.0.5...sattle-v0.0.6) (2026-09-07)


### Features

* add note management and activity history ([785b56d](https://github.com/tompro/sattle/commit/785b56de3b34fb3752abd7fa637aaa4773380924))
* add note management and activity history ([644e64e](https://github.com/tompro/sattle/commit/644e64ee10bba66609acf5161e176770b5bf5ee1))

## [0.0.5](https://github.com/tompro/sattle/compare/sattle-v0.0.4...sattle-v0.0.5) (2026-09-05)


### Features

* adopt lnurlcash-kit 0.8 with BIP-32-derived note secrets ([d026533](https://github.com/tompro/sattle/commit/d02653345639539c9c9268c1b6f1fd2a0359bb30))
* **backup:** preserve BIP-32 counters ([641608e](https://github.com/tompro/sattle/commit/641608eff07464613570818cf1463ca28702d7c7))
* **biometrics:** unlock complete wallet material ([b7c0a33](https://github.com/tompro/sattle/commit/b7c0a33a6968756e372a8b99156d70b766c2691d))
* **composables:** route fund dialogs through the durable seam ([8e9c9dc](https://github.com/tompro/sattle/commit/8e9c9dcbbc3cffa5db0ada5e7c486518ee9a1071))
* **funds:** persist BIP-32 counters atomically ([0cec423](https://github.com/tompro/sattle/commit/0cec423d6fe6edafa1d4d3a6520d2bc659906a1c))
* **funds:** recover staged mutations ([3876791](https://github.com/tompro/sattle/commit/3876791a0bc12851d74f7dd98424c4b30b788207))
* **keys:** persist BIP-32 wallet material ([d48deeb](https://github.com/tompro/sattle/commit/d48deeb6e0b32ffd3f5abc5fbc2080198e4ecb5b))
* **ops:** draw mint-touching output secrets from caller allocation ([22b1c55](https://github.com/tompro/sattle/commit/22b1c5595cea73c8e796e22b381d8c6a5d7fd564))
* **passkeys:** wrap complete wallet material ([6099bb4](https://github.com/tompro/sattle/commit/6099bb4b6b994b682662a33ef18da388e675b07e))
* **trust:** keep previous mint signing key verifiable ([a30c4bb](https://github.com/tompro/sattle/commit/a30c4bb2cc60250a22c3c3f2c044393bd4d2d778))
* **wallet:** allocate operation secrets from the cash root ([e6d0712](https://github.com/tompro/sattle/commit/e6d0712258dd31d85690687824d25b48240ca16e))


### Bug Fixes

* **composables:** commit carve checkpoints by output secret ([04e6211](https://github.com/tompro/sattle/commit/04e62110b66c4be50f07a97aec48d3f68f6c9989))
* **nwc:** await durable commits before responses ([29830dc](https://github.com/tompro/sattle/commit/29830dc9e3d34d2e626d0d6df52c86beca02d4b8))
* **passkeys:** bind slots to wallet material ([9374a87](https://github.com/tompro/sattle/commit/9374a87d0d64cfd70f5bf938cdf4582331cea87a))
* **unlock:** bind factors to wallet material ([7e4e67e](https://github.com/tompro/sattle/commit/7e4e67e1cddc836830add3baf787a0c5368102f7))
* **wallet:** activate complete wallet material ([e94549a](https://github.com/tompro/sattle/commit/e94549a16e983875eaf445287108b62212255d61))

## [0.0.4](https://github.com/tompro/sattle/compare/sattle-v0.0.3...sattle-v0.0.4) (2026-08-31)

### Features

- **funds:** keep the claimable note of a pending named transfer ([c996393](https://github.com/tompro/sattle/commit/c9963934aa6bc384cd9742e099b2c72b1f69e400))
- **lnurlcash:** claim mint outputs named by a wallet-chosen secret ([58268b2](https://github.com/tompro/sattle/commit/58268b2921d05c29ed4df98891e5ab5069617dfb))
- **lnurlcash:** probe would-be outputs before believing a mutation refusal ([48be23d](https://github.com/tompro/sattle/commit/48be23dceb940b28166b242ff308600864b87dd2))
- **lnurlcash:** transfer to mints with wallet-named outputs ([67b2122](https://github.com/tompro/sattle/commit/67b2122e52399b85e4829a0b3b61224252ae8ebf))
- **nwc:** make_invoice against mints with wallet-named outputs ([ae5064b](https://github.com/tompro/sattle/commit/ae5064b69a545a9ade671b5d701d5399fe3517ed))
- **receive:** accept named mints that serve no verify URL ([39a144c](https://github.com/tompro/sattle/commit/39a144cf50d621908b79cc27c7c664f6f9fc369c))
- support LUD-25 named mint outputs (lnurl-mint v0.4.0) ([f3d5cc4](https://github.com/tompro/sattle/commit/f3d5cc4b31cf0dba845e3abc4fa1b108c34122e5))

### Bug Fixes

- commit carves before the settlement wait ([#6](https://github.com/tompro/sattle/issues/6)) ([09f7fe0](https://github.com/tompro/sattle/commit/09f7fe02872838253882451ce7ed1f818f4ace62))
- commit send, pay and move carves at the checkpoint ([#6](https://github.com/tompro/sattle/issues/6)) ([9e37fee](https://github.com/tompro/sattle/commit/9e37fee841ab1c8ecb6bf7e3d00dfd61414ce306))
- **lnurlcash:** assert named claims land at the wallet's own secret ([6bb07ff](https://github.com/tompro/sattle/commit/6bb07ff9ec5c69b01c1822471c24312b44707927))
- **lnurlcash:** commit carves before the settlement wait ([#6](https://github.com/tompro/sattle/issues/6)) ([587dd11](https://github.com/tompro/sattle/commit/587dd11ba8a413c12dde134b11b2040c9d383c86))
- **lnurlcash:** rescue landed mutations from retry refusals ([50b2427](https://github.com/tompro/sattle/commit/50b2427b8db07692a590ff2602a034385bbac7df))
- replace forgesworn with moneyer in the public mint suggestions ([4cc8e0a](https://github.com/tompro/sattle/commit/4cc8e0aba2bd7ef8e4ea7d1b0ee9b98f21d19ee7))

## [0.0.3](https://github.com/tompro/sattle/compare/sattle-v0.0.2...sattle-v0.0.3) (2026-08-24)

### Features

- activate only proven wallet owners ([c319e11](https://github.com/tompro/sattle/commit/c319e11d3eff2a4ae0bb42d23628750ed12de8fc))
- add persisted owner guards and events ([69fbdb6](https://github.com/tompro/sattle/commit/69fbdb68ee3edccc7561fe4c201ef4497443d331))
- apply owner-aware wallet backups ([7607e47](https://github.com/tompro/sattle/commit/7607e47358fe4d9736c04853b784e05b2bef20c1))
- apply wallet fund changes atomically ([5b3a69e](https://github.com/tompro/sattle/commit/5b3a69e91055082e9c8cabb09d3c02302db05a37))
- await owner-aware Nostr restores ([f55f208](https://github.com/tompro/sattle/commit/f55f20883671ccd0fd696f3696a76fa739738fa6))
- await trusted mint management actions ([3c2a2cc](https://github.com/tompro/sattle/commit/3c2a2cc4a580126e8c199268aa543719ed771c2e))
- bind saved keys to versioned wallet owners ([acfab83](https://github.com/tompro/sattle/commit/acfab8343897f69dd714474724f419eef569fe7a))
- commit bearer changesets in one write ([586d12b](https://github.com/tompro/sattle/commit/586d12b666e13f040254ffbc1c618859cf7659b4))
- converge trusted mints on storage events ([83c9e5b](https://github.com/tompro/sattle/commit/83c9e5b95ff6d7189534437180141bcfd86d282c))
- create owner-bound NWC connections ([228a92b](https://github.com/tompro/sattle/commit/228a92b0f0f3238bee0cf0bcf7315f6b88dbae30))
- drain tracked NWC handlers on stop ([3ed214c](https://github.com/tompro/sattle/commit/3ed214c157743dc6ba2c28be25022bf65765a904))
- expose fund ownership assertions ([845ec41](https://github.com/tompro/sattle/commit/845ec410e506f1ba6a1c9c2666a9e6282d391755))
- fence wallet mutations by lifecycle owner ([9fa4abd](https://github.com/tompro/sattle/commit/9fa4abdaf3f775512e6e9c1caed72bb0ade76544))
- harden passkey ceremonies ([d9be457](https://github.com/tompro/sattle/commit/d9be457221a774d330c9d7c7cfa67487ece2a039))
- invalidate stale wallet tabs ([2e0f003](https://github.com/tompro/sattle/commit/2e0f0038f756d935c3674fb85c0d042a946ff9d8))
- preserve trusted mint rekey transitions ([d890a69](https://github.com/tompro/sattle/commit/d890a69c406b28a7f18bd6b356d9ad7eaab66341))
- restore Nostr backups through wallet lifecycle ([3f6010b](https://github.com/tompro/sattle/commit/3f6010b31262f3ea7ee5ac65c1dd7bcf6fa15635))
- scope NWC storage to wallet owners ([9f6bcad](https://github.com/tompro/sattle/commit/9f6bcad706760cd428e462ae28557f28362fddcf))
- scope passkey slots to proven owners ([12e4ec9](https://github.com/tompro/sattle/commit/12e4ec9199bfd78b741ae38d0fd49135594d85eb))
- scope trusted mint state in Pinia ([81c28ec](https://github.com/tompro/sattle/commit/81c28ec16dee42b7705ac97dc047a3486045c9ab))
- serialize trusted mint transactions ([d735aca](https://github.com/tompro/sattle/commit/d735aca885a63ff2bf9d96dd6732f02e63c382d4))
- serialize wallet lifecycle transitions ([62b93ba](https://github.com/tompro/sattle/commit/62b93baa05789961f2e8ed336c1d079e666f311e))
- validate trusted mint registry envelopes ([82f008b](https://github.com/tompro/sattle/commit/82f008b33f0843b8c999d26f1f7d4dd62e6c45b2))

### Bug Fixes

- await NWC payment bearer commits ([09b7b63](https://github.com/tompro/sattle/commit/09b7b63c9ddf5f19bc14bd35f253387b7862cece))
- await wallet commits in the NWC store ([99e6ae1](https://github.com/tompro/sattle/commit/99e6ae1b12de9f269c456ef015774cbe64c2b205))
- clear runtime state after lifecycle failures ([3acc63e](https://github.com/tompro/sattle/commit/3acc63e96866bd8c7f690499322f6cc631c0e329))
- commit carved wallet funds atomically ([c59521a](https://github.com/tompro/sattle/commit/c59521a421a3a8b40afd9d3e6088a2c36bc56354))
- consume owner monitor transition failures ([e892a33](https://github.com/tompro/sattle/commit/e892a330fc386e68f5ff11237cd3fd54534d68c6))
- drain accepted NWC work before wallet lock ([e983734](https://github.com/tompro/sattle/commit/e98373491fe7295cfc2a817d64ebdab0b1895a18))
- fence carve operations before mutation ([6fa4283](https://github.com/tompro/sattle/commit/6fa4283ed65cd3943beb4486aee8e876732b73c5))
- fence inter-mint transfer operations ([02f901c](https://github.com/tompro/sattle/commit/02f901c87c0f983b67ea50619e0f8a42585acf0a))
- fence invoice payment operations ([c4c9d8a](https://github.com/tompro/sattle/commit/c4c9d8a94ae4856d8e81ca6faa6b1d0a4d871b60))
- fence mint and receive operations ([7f69f78](https://github.com/tompro/sattle/commit/7f69f781f55239de5502d8c17954d582a0ee45e6))
- fence send and pay flows ([401a26d](https://github.com/tompro/sattle/commit/401a26dc6b1221641bcdcbc1aa1e5464025ec41c))
- hide invoice settlement until commit ([513c67f](https://github.com/tompro/sattle/commit/513c67fc143d27c1e57c3c2c6771a0f622152382))
- mirror trusted mint commits across tabs ([e9bbb35](https://github.com/tompro/sattle/commit/e9bbb358aae79d3ce1fa6690749e9d63d3c748ff))
- normalize storage lock failures ([1dbf578](https://github.com/tompro/sattle/commit/1dbf5788f9b82162122eea205ea3d6e9c5badf1a))
- preserve conservative NWC budget debits ([fff24a7](https://github.com/tompro/sattle/commit/fff24a75b24f7a80e4f3f517525c7eb0c2d93155))
- publish activity only after persistence ([54031dc](https://github.com/tompro/sattle/commit/54031dc8de03448aa3cee6c2a8a9d035d92c752c))
- surface receive post-commit trust failures ([f087ebe](https://github.com/tompro/sattle/commit/f087ebe2f2e28bbd0e4c3cfe3407e77c0a78a7aa))
- validate auxiliary wallet storage ([0862a10](https://github.com/tompro/sattle/commit/0862a10b01d33fd9c0f7f7a3f69a738e89af8c19))
- validate NWC requests before dispatch ([b52172c](https://github.com/tompro/sattle/commit/b52172c0cb28884b0d00636f601cac0a52e6d504))
- **wallet:** enforce owner-bound integrity and durable commits ([338b281](https://github.com/tompro/sattle/commit/338b2812e357f01027800985051e62dea6c207d8))

## [0.0.2](https://github.com/tompro/sattle/compare/sattle-v0.0.1...sattle-v0.0.2) (2026-08-20)

### Features

- backup and security settings pages, nostr restore onboarding, passkey unlock entry ([1920a00](https://github.com/tompro/sattle/commit/1920a00cd65651f057cc44f4e38d14f8353cfa09))
- capability layer for clipboard, share and deep links with tests ([f525b06](https://github.com/tompro/sattle/commit/f525b069664cc34fbac3c00f5101aaabd774fece))
- capacitor android platform project ([3f22534](https://github.com/tompro/sattle/commit/3f22534cf0f30f1a2bc1ab1aa645517e85a7949c))
- deep link routing for lightning and lnurl schemes plus association files ([229e9fc](https://github.com/tompro/sattle/commit/229e9fcf38addc843a81a4b57e1f70cec76f36fd))
- inter-mint transfer op with fee quote and ambiguity-safe outcomes ([142734b](https://github.com/tompro/sattle/commit/142734b903e932a36db2d0e62a4c66ceb9ee9fd6))
- manage mints and move funds settings pages ([f631c7c](https://github.com/tompro/sattle/commit/f631c7c264fe962b33ba2c8ea1cc3f8974cc6607))
- native biometric unlock via biometric-gated wrap of the linking key ([e59b722](https://github.com/tompro/sattle/commit/e59b722b5e9093e34b336f0cb0446e34383d4df7))
- nip-47 nwc wallet service engine with per-connection budgets ([33318a5](https://github.com/tompro/sattle/commit/33318a5150afd55b5580dd5a15052434aefde90f))
- nostr kind-30078 backup engine with nip-44 self-encryption and merge-on-restore ([7ecade3](https://github.com/tompro/sattle/commit/7ecade32eeb277d9bd6df734ddc76232f06bdee0))
- nwc connections settings page with one-time connection strings and service lifecycle ([5221127](https://github.com/tompro/sattle/commit/52211273b15e0eb503d5466a250f756a3ed3548a))
- pinia wallet, mints and activity stores with wallet boot ([fdd12dc](https://github.com/tompro/sattle/commit/fdd12dcc1eff116bf335673744e519975b3f3ef2))
- reusable mint fee math with cached quotes, fee-aware Max in move funds ([f4b9377](https://github.com/tompro/sattle/commit/f4b9377d17a2736c429a7272fac8b1742098a60d))
- sattle branding, logo assets and generated app icons ([48e4c84](https://github.com/tompro/sattle/commit/48e4c840929e68cd1740669379b7ed5ed37d32b0))
- send/receive dialogs, qr scanner, history and unlock components ([48fffff](https://github.com/tompro/sattle/commit/48fffff02a17c303dbf807de140d56af26cae88f))
- wallet operations engine and encrypted storage with tests ([1c9e716](https://github.com/tompro/sattle/commit/1c9e7165e4269996891e9112951c3ec75a6e6898))
- wallet screens, branded header layout and mobile-first main view ([1fe1453](https://github.com/tompro/sattle/commit/1fe1453745f3ab9132decb984242b586588c3178))
- webauthn prf passkey unlock engine as alternative wrap of the linking key ([7db3408](https://github.com/tompro/sattle/commit/7db34083e6345fb5acbf31722736d24fa0441815))

### Bug Fixes

- bind window.fetch at boot so lnurlcash-kit transport works in browsers ([1839700](https://github.com/tompro/sattle/commit/18397002150eca483ba1f00951715e30fbacd792))
- discover a mint's signing key from the mint-address endpoint, not the payRequest ([3926121](https://github.com/tompro/sattle/commit/39261212cf1b27626b2f33de045081a9adfc2592))

## Changelog

All notable changes to sattle are documented in this file. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
releases are automated with
[release-please](https://github.com/googleapis/release-please) from
conventional commits: it maintains a release PR that bumps `package.json`
and updates this file; merging that PR tags `vX.Y.Z` and creates the
GitHub release.
