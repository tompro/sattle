// The operations engine: every multi-step wallet flow (carving exact
// amounts, minting, receiving, paying), framework-free. Pinia stores call
// these and apply the returned changesets; UI components never touch
// lnurlcash-kit directly. Every function takes bearers in and returns the
// new/changed notes out - it never mutates wallet state itself.
//
// Fund-critical invariants enforced across the flows (see the project plan):
// - rotate on every receive, and immediately after claiming a fresh mint
//   (observer race: anyone who saw the unpaid invoice knows the payment
//   hash, and the mint necessarily saw the preimage - the preimage IS the
//   note secret)
// - a note's declared amount is a claim; the service's maxWithdrawable is
//   authoritative
// - a melt's "OK" only means the payment is in flight; its verify URL (or
//   the note becoming spendable again) is the real outcome
// - an ambiguous mutation NEVER loses the fresh secrets it carries: they
//   are either rescued into tracked notes, probed, or surfaced to the
//   caller unverified for later reconcile
//
// The engine is split by flow; this façade is the single import surface:
//   ops/carve.ts         - ensureExactAmount (merge/split exact-amount carving)
//   ops/mint.ts          - prepareMint / claimMintedNote (receive over Lightning)
//   ops/receiveBearer.ts - receiveBearer (receive a note, rotate on receive)
//   ops/pay.ts           - payWithBearers (melt to bolt11 / Lightning Address)
//   ops/transfer.ts      - transferBetweenMints (inter-mint move: melt at
//                          source, mint + claim + rotate at target)
//   ops/shared.ts        - bounded verify polling, UncertainOutcomeError

export {UncertainOutcomeError} from './ops/shared'
export type {PollOptions} from './ops/shared'
export {ensureExactAmount} from './ops/carve'
export type {CarveResult} from './ops/carve'
export {prepareMint, claimMintedNote} from './ops/mint'
export type {PreparedMint, ClaimedNote} from './ops/mint'
export {receiveBearer} from './ops/receiveBearer'
export {payWithBearers} from './ops/pay'
export type {PayOutcome, PayResult, PayOptions} from './ops/pay'
export {transferBetweenMints} from './ops/transfer'
export type {
  TransferClaimMaterial,
  TransferOptions,
  TransferOutcome,
  TransferQuote,
  TransferResult
} from './ops/transfer'
