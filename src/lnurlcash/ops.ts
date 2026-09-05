// The operations engine: every multi-step wallet flow (carving exact
// amounts, minting, receiving, paying), framework-free. Pinia stores call
// these and apply the returned changesets; UI components never touch
// lnurlcash-kit directly. Every function takes bearers in and returns the
// new/changed notes out - it never mutates wallet state itself.
//
// Fund-critical invariants enforced across the flows (see the project plan):
// - rotate every externally received bearer. Minted notes are staged at a
//   wallet-chosen secret before invoice creation and claimed there without
//   rotating; the payment preimage is not bearer material
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
//                          source, mint + claim at target)
//   ops/shared.ts        - bounded polling, UncertainOutcomeError

export {UncertainOutcomeError} from './ops/shared'
export type {FundOperationOptions, PollOptions} from './ops/shared'
export {OutputSecretAllocationRequiredError} from './ops/allocation'
export type {OutputSecretAllocator} from './ops/allocation'
export {
  CarveCheckpointRequiredError,
  ensureExactAmount,
  UnsupportedMultiBatchMergeError,
} from './ops/carve'
export type {CarveOptions, CarveResult} from './ops/carve'
export {
  MintedNoteSpentError,
  prepareMint,
  claimMintedNote,
  recoverStagedMintOutput,
} from './ops/mint'
export type {
  PreparedMint,
  PrepareMintOptions,
  ClaimedNote,
  StagedMintRecovery,
} from './ops/mint'
export {receiveBearer, ReceiveRotationStagingRequiredError} from './ops/receiveBearer'
export type {ReceiveBearerOptions, ReceivedNote} from './ops/receiveBearer'
export {payWithBearers, PayReturnCheckpointRequiredError} from './ops/pay'
export type {PayOutcome, PayResult, PayOptions} from './ops/pay'
export {
  recoverPendingTransferSource,
  transferBetweenMints,
  TransferMeltCheckpointRequiredError,
} from './ops/transfer'
export type {
  TransferClaimMaterial,
  TransferOptions,
  TransferOutcome,
  TransferQuote,
  TransferResult,
} from './ops/transfer'
