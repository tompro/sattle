// The published lnurlcash-conformance 0.4.0 hand-written declarations
// (mock-mint/index.d.ts) are stale relative to their own index.mjs: the
// comment-naming flags are implemented and documented in the CHANGELOG
// ("The mock mint gains commentAllowed, commentRefusesMalformed and
// verifyOnUnnamedMint") but never made it into the type surface. This
// augmentation restores them so tests can drive the comment-named mint
// mode without `as any`. Report upstream; drop this file once a release
// ships the declarations.
//
// Semantics (from mock-mint/index.mjs):
// - commentAllowed: false (default) means the pay callback ignores the
//   `comment` parameter entirely. A number advertises that many
//   characters on the payRequest and reads `comment` on the callback: a
//   bare 64-hex sha256 binds the minted note to the wallet's secret
//   (k1 = secret, preimage opens nothing); anything else falls back to
//   preimage keying and verify is withheld for that quote.
// - commentRefusesMalformed: non-compliant; refuses a non-hash comment
//   instead of falling back.
// - verifyOnUnnamedMint: non-compliant; serves LUD-21 verify even on the
//   no-comment fallback, where the preimage it hands out IS the note.

declare module 'lnurlcash-conformance/mock-mint' {
  interface MockMintOptions {
    commentAllowed?: number | false
    commentRefusesMalformed?: boolean
    verifyOnUnnamedMint?: boolean
  }
}

export {}
