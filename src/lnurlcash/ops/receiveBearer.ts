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
  probeBurnedNote,
  withNewK1,
} from 'lnurlcash-kit'
import type {Bearer, NewBearer} from '../types'
import {receiveNote, secureReceivedNote} from '../receive'
import type {ClaimedNote} from './mint'
import type {FundOperationOptions} from './shared'
import {assertFundOwner} from './shared'

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
    const rotatedUrl = await secureReceivedNote(note)
    return {note: {...note, url: rotatedUrl}, rotated: true}
  } catch (err) {
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
