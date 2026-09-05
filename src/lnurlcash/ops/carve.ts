// ensureExactAmount: carve an exact amount out of the held notes, merging
// and/or splitting as needed, into a single fresh note worth exactly the
// target - the operation every send and every melt starts from.
//
// Every output secret is chosen and reported through options.onCarve BEFORE
// its hash reaches the mint. That first checkpoint stages possible outputs
// without retiring inputs; a second checkpoint retires the inputs only after
// the mutation is known to have landed.

import {
  AmbiguousMutationError,
  defaultRandomSecret,
  mergeBatches,
  newSecretsOf,
  noteK1,
  probeBurnedNote,
  requireNoteK1,
  serverOf,
  splitNote,
  withNewK1,
} from 'lnurlcash-kit'
import type {Bearer, NewBearer} from '../types'
import {mergeAmbiguitySafe} from './carveRecovery'
import type {FundOperationOptions} from './shared'
import {
  assertFundOwner,
  landedNoteVerifies,
  probeMutationOutput,
  UncertainOutcomeError,
  withMutationSafety,
} from './shared'

// The same shape serves both checkpoint phases: the pre-wire phase carries
// note/change with an empty consumed list, and the landed phase carries the
// already-staged note plus the inputs the caller can now retire.
export type CarveResult = {
  // the exact-amount note, ready to hand over or melt
  note: NewBearer
  // the remainder note, when the carve split a larger input
  change?: NewBearer
  // the input notes burned server-side by the carve (empty when a single
  // note already held exactly the target amount)
  consumed: Bearer[]
}

export class UnsupportedMultiBatchMergeError extends Error {
  override readonly name = 'UnsupportedMultiBatchMergeError'

  constructor() {
    super('This carve would require multiple merge requests and cannot be performed safely.')
  }
}

export class CarveCheckpointRequiredError extends Error {
  override readonly name = 'CarveCheckpointRequiredError'

  constructor() {
    super('A mutating carve requires a durable onCarve checkpoint.')
  }
}

// Selection: only notes that can actually take part - verified (callback
// known), not locally spent, holding a real k1 (device-backed mirrors are
// excluded; the ops engine cannot mutate a secret it doesn't hold). Notes
// are grouped by issuing server (a mutation only ever spans one service),
// picked greedily smallest-first within a group until the target is
// covered, and the group with the least waste wins (ties: fewer notes).
//
// Execution, mirroring lnurl-wallet's SendDialog:
// - one note already exact: returned as-is, nothing burned
// - several notes summing exactly: one merge; folds spanning multiple
//   requests are rejected because partial progress needs a larger journal
// - total above target (one or many notes): a single split request (LUD-25
//   split takes many k1s - no merge round trip first); change stays
//   unverified until refresh because a second settle mutation would create
//   another crash window
export const ensureExactAmount = async (
  bearers: Bearer[],
  amountMsat: number,
  options: FundOperationOptions = {},
): Promise<CarveResult> => {
  if (!Number.isInteger(amountMsat) || amountMsat <= 0) {
    throw new Error('Amount must be a positive whole number of msat.')
  }
  // the forced mutation policy (signatures required, one byte-identical
  // replay) applies to every mint call below regardless of caller options
  const mutationOptions = withMutationSafety(options)
  const eligible = bearers.filter(
    (b) => b.verified && !b.spent && b.callback !== '' && !b.deviceId && noteK1(b.url),
  )
  // per-server greedy pick: smallest notes first until the target is
  // covered (an exact single-note match short-circuits - no mutation at
  // all is always better than carving)
  const byServer = new Map<string, Bearer[]>()
  for (const b of eligible) {
    const server = serverOf(b.url)
    byServer.set(server, [...(byServer.get(server) ?? []), b])
  }
  let pick: Bearer[] | null = null
  for (const group of byServer.values()) {
    const sorted = [...group].sort((a, b) => a.amount - b.amount)
    const exact = sorted.find((b) => b.amount === amountMsat)
    const candidate = exact ? [exact] : accumulate(sorted, amountMsat)
    if (!candidate) continue
    if (!pick || better(candidate, pick, amountMsat)) pick = candidate
  }
  if (!pick) {
    throw new Error('No mint holds enough verified, unspent balance to cover that amount.')
  }
  const base = pick[0]
  const total = pick.reduce((sum, b) => sum + b.amount, 0)
  const k1s = pick.map((b) => requireNoteK1(b.url))

  const checkpoint = async (result: CarveResult): Promise<void> => {
    if (!options.onCarve) {
      throw new CarveCheckpointRequiredError()
    }
    assertFundOwner(options)
    await options.onCarve(result)
    assertFundOwner(options)
  }
  const stage = (result: CarveResult): Promise<void> =>
    checkpoint({...result, consumed: []})
  const retire = (note: NewBearer): Promise<void> => checkpoint({note, consumed: pick})

  if (pick.length === 1 && total === amountMsat) {
    // already exact - hand over the note itself, untouched
    return {
      note: {
        url: base.url,
        callback: base.callback,
        amount: base.amount,
        verified: base.verified,
        mintPubkey: base.mintPubkey,
      },
      consumed: [],
    }
  }

  if (total === amountMsat) {
    if (mergeBatches(base.callback, k1s).length !== 1) {
      throw new UnsupportedMultiBatchMergeError()
    }
    const mergeSecret = (options.randomSecret ?? defaultRandomSecret)()
    const staged: NewBearer = {
      url: withNewK1(base.url, mergeSecret, total),
      callback: base.callback,
      amount: total,
      verified: false,
      mintPubkey: base.mintPubkey,
    }
    await stage({note: staged, consumed: pick})
    assertFundOwner(options)
    const merged = await mergeAmbiguitySafe(base, k1s, {
      ...mutationOptions,
      randomSecret: () => mergeSecret,
    })
    // a landed merge reports its signature (carried in the URL's sig param)
    // and earns verified only when that signature checks against a trusted
    // current or previous key; a rescued merge saw no answer, so its note
    // stays exactly as staged - unverified, same URL
    const landedUrl = withNewK1(base.url, mergeSecret, total, merged.signature)
    const result: CarveResult = merged.rescued
      ? {note: staged, consumed: pick}
      : {
          note: {
            ...staged,
            url: landedUrl,
            verified: landedNoteVerifies(landedUrl, options.mintSignatureKeys),
          },
          consumed: pick,
        }
    await retire(result.note)
    return result
  }

  // split path: total above target - one split request across all picked
  // k1s, carving the target off and leaving the change as a fresh note
  const randomSecret = options.randomSecret ?? defaultRandomSecret
  const partK1 = randomSecret()
  const changeK1 = randomSecret()
  let partSignature: string | undefined
  let changeSignature: string | undefined
  const stagedNote: NewBearer = {
    url: withNewK1(base.url, partK1, amountMsat),
    callback: base.callback,
    amount: amountMsat,
    verified: false,
    mintPubkey: base.mintPubkey,
  }
  const stagedChange: NewBearer = {
    url: withNewK1(base.url, changeK1, total - amountMsat),
    callback: base.callback,
    amount: total - amountMsat,
    verified: false,
    mintPubkey: base.mintPubkey,
  }
  await stage({note: stagedNote, change: stagedChange, consumed: pick})
  let secretIndex = 0
  const preparedSecret = (): string => {
    secretIndex += 1
    if (secretIndex === 1) return partK1
    if (secretIndex === 2) return changeK1
    throw new Error('The split requested more output secrets than were staged.')
  }
  assertFundOwner(options)
  try {
    const parts = await splitNote(base.callback, k1s, amountMsat, {
      ...mutationOptions,
      randomSecret: preparedSecret,
    })
    partSignature = parts.signature
    changeSignature = parts.changeSignature
  } catch (err) {
    if (err instanceof AmbiguousMutationError) {
      // the split request may have landed despite the failure - probe one
      // input before deciding what the carried secrets are worth
      const outcome = await probeBurnedNote(base.url, mutationOptions)
      if (outcome === 'live') throw err // nothing burned - a plain failure
      if (outcome === 'unknown') {
        // can't tell: surface both possible outputs unverified WITHOUT
        // consuming the inputs, and stop here rather than spend from limbo
        throw new UncertainOutcomeError(
          'The split may have gone through but could not be confirmed - its possible outputs were already staged unverified alongside the originals.',
          [],
        )
      }
      // 'gone': the burn landed - the carried secrets are the only money
    } else {
      // A classified refusal can still be a LANDED split: the callback is
      // a GET and HTTP stacks retry GETs, so the service may have executed
      // the first attempt and refused this one as an already-spent input.
      // The kit attaches the fresh output secrets to every refusal - probe
      // one output before deciding they are worthless.
      const carried = newSecretsOf(err)
      if (carried.length !== 2) throw err
      const outcome = await probeMutationOutput(base.url, carried[0], mutationOptions)
      if (outcome === 'absent') throw err // never landed - a plain refusal
      if (outcome === 'unknown') {
        // can't tell whether the refusal named a retry - same limbo as
        // the ambiguous case above: track the possible outputs, consume
        // nothing, stop here
        throw new UncertainOutcomeError(
          'The split was refused, but the refusal may have named a retry that already landed - its possible outputs were already staged unverified alongside the originals.',
          [],
        )
      }
      // 'live': the split landed and this answer was its retried twin -
      // the carried secrets are the only money left
    }
  }
  // the landed answer's signatures ride in the URLs (sig param); a rescued
  // split saw no answer, so its notes keep the staged sig-less URLs. Only a
  // signature that verifies against a trusted current/previous key earns
  // verified:true - anything else stays staged unverified for a refresh.
  const noteUrl =
    partSignature === undefined
      ? stagedNote.url
      : withNewK1(base.url, partK1, amountMsat, partSignature)
  const note: NewBearer = {
    url: noteUrl,
    callback: base.callback,
    amount: amountMsat,
    verified: landedNoteVerifies(noteUrl, options.mintSignatureKeys),
    mintPubkey: base.mintPubkey,
  }
  // The change may be worth less than total - amount when the mint charges
  // split fees. It remains unverified at that upper bound until refresh;
  // settling it here would rotate to an unstaged secret in a second request.
  const changeUrl =
    changeSignature === undefined
      ? stagedChange.url
      : withNewK1(base.url, changeK1, total - amountMsat, changeSignature)
  const change: NewBearer = {
    url: changeUrl,
    callback: base.callback,
    amount: total - amountMsat,
    verified: false,
    mintPubkey: base.mintPubkey,
  }
  const result = {note, change, consumed: pick}
  await retire(note)
  return result
}

// smallest-first accumulation until the target is covered; null when the
// whole group can't reach it
const accumulate = (sorted: Bearer[], amountMsat: number): Bearer[] | null => {
  const picked: Bearer[] = []
  let total = 0
  for (const b of sorted) {
    picked.push(b)
    total += b.amount
    if (total >= amountMsat) return picked
  }
  return null
}

// the better carve plan: less waste first, then fewer notes burned
const better = (a: Bearer[], b: Bearer[], target: number): boolean => {
  const sum = (notes: Bearer[]) => notes.reduce((s, n) => s + n.amount, 0)
  const wasteA = sum(a) - target
  const wasteB = sum(b) - target
  if (wasteA !== wasteB) return wasteA < wasteB
  return a.length < b.length
}
