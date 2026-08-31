// Receiving a bearer note: wraps receive.ts's receiveNote +
// secureReceivedNote into one flow - resolve whatever came in (note URL,
// bech32, lnurlw://), verify it with the issuing service, then rotate
// immediately, since the previous holder (and anything that logged the URL
// in transit) still knows the old secret.

import {
  AmbiguousMutationError,
  NoteSpentError,
  NoteUnknownError,
  PendingNoteError,
  newSecretsOf,
  probeBurnedNote,
  withNewK1,
} from 'lnurlcash-kit'
import type {Bearer, NewBearer} from '../types'
import {receiveNote, secureReceivedNote} from '../receive'
import type {ClaimedNote} from './mint'
import type {FundOperationOptions} from './shared'
import {assertFundOwner, probeMutationOutput} from './shared'

// NoteSpentError / NoteUnknownError / PendingNoteError from the service are
// definitive and propagate; an unreachable service still yields the note,
// unverified, at the sender's declared amount.
export const receiveBearer = async (
  input: string,
  existing: Bearer[],
  options: FundOperationOptions = {},
): Promise<ClaimedNote> => {
  const note = await receiveNote(input, existing)
  if (!note.verified || !note.callback) {
    return {note, rotated: false}
  }
  try {
    assertFundOwner(options)
    const rotatedUrl = await secureReceivedNote(note, options)
    return {note: {...note, url: rotatedUrl}, rotated: true}
  } catch (err) {
    // A classified rotate refusal can still be a LANDED rotate: the
    // callback is a GET and HTTP stacks retry GETs, so the service may
    // have executed the first attempt and refused this one as an
    // already-spent input. The refusal then proves the sender's copy is
    // burned and the carried fresh secret is the only money left - probe
    // it before believing the refusal.
    const carried = newSecretsOf(err)
    if (carried.length === 1 && !(err instanceof AmbiguousMutationError)) {
      const outcome = await probeMutationOutput(note.url, carried[0], options)
      if (outcome === 'live') {
        return {
          note: {...note, url: withNewK1(note.url, carried[0], note.amount)},
          rotated: true,
        }
      }
      if (outcome === 'unknown') {
        const possibleCopy: NewBearer = {
          url: withNewK1(note.url, carried[0], note.amount),
          callback: note.callback,
          amount: note.amount,
          verified: false,
        }
        if (note.mintPubkey) possibleCopy.mintPubkey = note.mintPubkey
        return {
          // the sender's copy may be burned - it cannot stay verified
          note: {...note, verified: false},
          rotated: false,
          possibleCopy,
          rotationError: `${err instanceof Error ? err.message : String(err)} The refusal may have named a retry of a rotation that already landed - the possible rotated copy is tracked unverified alongside this one.`,
        }
      }
      // 'absent': the refusal is genuine - fall through to the distinct
      // handling below
    }
    // a definitive service state (dead/unknown/locked mid-melt) is not a
    // rotation failure to warn about - it tells the holder what this note
    // actually is, so it propagates distinctly
    if (
      err instanceof NoteSpentError ||
      err instanceof PendingNoteError ||
      err instanceof NoteUnknownError
    ) {
      throw err
    }
    if (err instanceof AmbiguousMutationError) {
      const outcome = await probeBurnedNote(note.url, options)
      if (outcome === 'gone') {
        return {
          note: {
            ...note,
            url: withNewK1(note.url, err.newSecrets[0], note.amount),
          },
          rotated: true,
        }
      }
      if (outcome === 'unknown') {
        const possibleCopy: NewBearer = {
          url: withNewK1(note.url, err.newSecrets[0], note.amount),
          callback: note.callback,
          amount: note.amount,
          verified: false,
        }
        if (note.mintPubkey) possibleCopy.mintPubkey = note.mintPubkey
        return {
          note,
          rotated: false,
          possibleCopy,
          rotationError: `${err.message} The rotation may still have gone through - the possible rotated copy is tracked unverified alongside this one.`,
        }
      }
    }
    // a failed rotate never fails the receive - the note is money as it
    // is; the caller warns that it must be treated as exposed
    return {
      note,
      rotated: false,
      rotationError: err instanceof Error ? err.message : String(err),
    }
  }
}
