// ensureExactAmount: carve an exact amount out of the held notes, merging
// and/or splitting as needed, into a single fresh note worth exactly the
// target - the operation every send and every melt starts from.

import {
  AmbiguousMutationError,
  mergeNotes,
  noteK1,
  probeBurnedNote,
  requireNoteK1,
  serverOf,
  settleNote,
  splitNote,
  withNewK1
} from 'lnurlcash-kit'
import type {LnurlcashOptions} from 'lnurlcash-kit'
import type {Bearer, NewBearer} from '../types'
import {UncertainOutcomeError} from './shared'

// the changeset stores apply after a mutation: `note`/`change` BEFORE
// `consumed` - the mint call already burned every consumed input
// server-side, so the outputs are the only money left and must be tracked
// first; a crash between the two must strand a duplicate, never a secret
export type CarveResult = {
  // the exact-amount note, ready to hand over or melt
  note: NewBearer
  // the remainder note, when the carve split a larger input
  change?: NewBearer
  // the input notes burned server-side by the carve (empty when a single
  // note already held exactly the target amount)
  consumed: Bearer[]
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
// - several notes summing exactly: one merge, then settle (reads the true
//   post-fee value back and rotates, since the read put k1 on the wire)
// - total above target (one or many notes): a single split request (LUD-25
//   split takes many k1s - no merge round trip first), then the change is
//   settled for its true value; the target part carries the mint's
//   signature and needs no settle
export const ensureExactAmount = async (
  bearers: Bearer[],
  amountMsat: number,
  options: LnurlcashOptions = {}
): Promise<CarveResult> => {
  if (!Number.isInteger(amountMsat) || amountMsat <= 0) {
    throw new Error('Amount must be a positive whole number of msat.')
  }
  const eligible = bearers.filter(
    b => !b.spent && b.callback !== '' && !b.deviceId && noteK1(b.url)
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
    const exact = sorted.find(b => b.amount === amountMsat)
    const candidate = exact ? [exact] : accumulate(sorted, amountMsat)
    if (!candidate) continue
    if (!pick || better(candidate, pick, amountMsat)) pick = candidate
  }
  if (!pick) {
    throw new Error(
      'No mint holds enough verified, unspent balance to cover that amount.'
    )
  }
  const base = pick[0]
  const total = pick.reduce((sum, b) => sum + b.amount, 0)
  const k1s = pick.map(b => requireNoteK1(b.url))

  if (pick.length === 1 && total === amountMsat) {
    // already exact - hand over the note itself, untouched
    return {
      note: {
        url: base.url,
        callback: base.callback,
        amount: base.amount,
        verified: base.verified,
        mintPubkey: base.mintPubkey
      },
      consumed: []
    }
  }

  if (total === amountMsat) {
    // merge path: many notes, exact sum - merge into one, then settle it
    // (true value + fresh secret; a failed settle leaves an unverified
    // note a refresh can repair, not a lost secret)
    const merged = await mergeAmbiguitySafe(base, k1s, total, options)
    const unverified: NewBearer = {
      url: withNewK1(base.url, merged.k1, total, merged.signature),
      callback: base.callback,
      amount: total,
      verified: false,
      mintPubkey: base.mintPubkey
    }
    // a merge whose answer was lost leaves the service in an unknown
    // state from here - settling fires another mutation (the rotate
    // inside settleNote) at it, whose own ambiguous failure would strand
    // the rescued secret. Don't compound: return unverified and let a
    // refresh repair.
    if (merged.rescued) return {note: unverified, consumed: pick}
    try {
      const settled = await settleNote(
        base.url,
        merged.k1,
        total,
        merged.signature,
        options
      )
      return {
        note: {
          url: withNewK1(
            base.url,
            settled.k1,
            settled.amountMsat,
            settled.signature
          ),
          callback: settled.callback,
          amount: settled.amountMsat,
          verified: true,
          mintPubkey: base.mintPubkey
        },
        consumed: pick
      }
    } catch {
      return {note: unverified, consumed: pick}
    }
  }

  // split path: total above target - one split request across all picked
  // k1s, carving the target off and leaving the change as a fresh note
  let partK1: string
  let partSignature: string | undefined
  let changeK1: string
  let changeSignature: string | undefined
  let partVerified = false
  // true when the split's answer was lost and the probe proved the burn -
  // the carried secrets were rescued, but the service is in an unknown
  // state, so the change is NOT settled (that would fire another mutation
  // at it, whose own ambiguous failure would strand the rescued secret)
  let rescued = false
  try {
    const parts = await splitNote(base.callback, k1s, amountMsat, options)
    partK1 = parts.k1
    partSignature = parts.signature
    changeK1 = parts.change
    changeSignature = parts.changeSignature
    partVerified = true
  } catch (err) {
    if (!(err instanceof AmbiguousMutationError)) throw err
    // the split request may have landed despite the failure - probe one
    // input before deciding what the carried secrets are worth
    const outcome = await probeBurnedNote(base.url, options)
    if (outcome === 'live') throw err // nothing burned - a plain failure
    if (outcome === 'unknown') {
      // can't tell: surface both possible outputs unverified WITHOUT
      // consuming the inputs, and stop here rather than spend from limbo
      throw new UncertainOutcomeError(
        'The split may have gone through but could not be confirmed - the possible outputs must be tracked unverified alongside the originals until refreshed.',
        [
          {
            url: withNewK1(base.url, err.newSecrets[0], amountMsat),
            callback: base.callback,
            amount: amountMsat,
            verified: false,
            mintPubkey: base.mintPubkey
          },
          {
            url: withNewK1(base.url, err.newSecrets[1], total - amountMsat),
            callback: base.callback,
            amount: total - amountMsat,
            verified: false,
            mintPubkey: base.mintPubkey
          }
        ]
      )
    }
    // 'gone': the burn landed - the carried secrets are the only money
    partK1 = err.newSecrets[0]
    changeK1 = err.newSecrets[1]
    rescued = true
  }
  const note: NewBearer = {
    url: withNewK1(base.url, partK1, amountMsat, partSignature),
    callback: base.callback,
    amount: amountMsat,
    verified: partVerified,
    mintPubkey: base.mintPubkey
  }
  // settleNote: the change may be worth less than total - amount if this
  // mint charges split fees (LUD-25 deducts them from change, never the
  // split-off amount) - it comes back at its true value, or stays
  // unverified at the naive pre-fee one for a refresh to repair
  let change: NewBearer = {
    url: withNewK1(base.url, changeK1, total - amountMsat, changeSignature),
    callback: base.callback,
    amount: total - amountMsat,
    verified: false,
    mintPubkey: base.mintPubkey
  }
  if (!rescued) {
    try {
      const settled = await settleNote(
        base.url,
        changeK1,
        total - amountMsat,
        changeSignature,
        options
      )
      change = {
        url: withNewK1(
          base.url,
          settled.k1,
          settled.amountMsat,
          settled.signature
        ),
        callback: settled.callback,
        amount: settled.amountMsat,
        verified: true,
        mintPubkey: base.mintPubkey
      }
    } catch {
      // settle is best-effort - the unverified change above is still tracked
    }
  }
  return {note, change, consumed: pick}
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

// merge with the full ambiguity protocol: probe one input, rescue the
// carried secret only once the burn is confirmed, surface it unverified
// when the probe can't tell either
const mergeAmbiguitySafe = async (
  base: Bearer,
  k1s: string[],
  total: number,
  options: LnurlcashOptions
): Promise<{k1: string; signature?: string; rescued: boolean}> => {
  try {
    const merged = await mergeNotes(base.callback, k1s, options)
    return {k1: merged.k1, signature: merged.signature, rescued: false}
  } catch (err) {
    if (!(err instanceof AmbiguousMutationError)) throw err
    const outcome = await probeBurnedNote(base.url, options)
    if (outcome === 'live') throw err // nothing burned - a plain failure
    if (outcome === 'unknown') {
      throw new UncertainOutcomeError(
        'The merge may have gone through but could not be confirmed - the possible combined note must be tracked unverified alongside the originals until refreshed.',
        [
          {
            url: withNewK1(base.url, err.newSecrets[0], total),
            callback: base.callback,
            amount: total,
            verified: false,
            mintPubkey: base.mintPubkey
          }
        ]
      )
    }
    // 'gone': the burn landed - the carried secret is the only money left
    return {k1: err.newSecrets[0], rescued: true}
  }
}
