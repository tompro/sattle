// Receiving a bearer note: wraps receive.ts's receiveNote +
// secureReceivedNote into one flow - resolve whatever came in (note URL,
// bech32, lnurlw://), verify it with the issuing service, then rotate
// immediately, since the previous holder (and anything that logged the URL
// in transit) still knows the old secret.
//
// Durability contract: the rotate's fresh secret comes from the caller's
// reservation path (options.allocateOutputSecrets) and the future rotated
// note is persisted through options.stageRotation BEFORE the rotate can
// land - a crash after the mint burned the sender's copy never loses the
// only secret the money answers to. The staged record carries the original
// k1 as its pendingMint.sourceRecoverySecret so wallet recovery can restore
// the received note when the rotate provably never landed.

import {
  AmbiguousMutationError,
  NoteSpentError,
  NoteUnknownError,
  PendingNoteError,
  newSecretsOf,
  probeBurnedNote,
  requireNoteK1,
  serverOf,
  withNewK1,
} from 'lnurlcash-kit';
import type { Bearer, NewBearer } from '../types';
import { receiveNote, secureReceivedNote } from '../receive';
import type { OutputSecretAllocator } from './allocation';
import { requireOutputSecrets } from './allocation';
import type { FundOperationOptions } from './shared';
import { assertFundOwner, probeMutationOutput, withMutationSafety } from './shared';

export class ReceiveRotationStagingRequiredError extends Error {
  override readonly name = 'ReceiveRotationStagingRequiredError';

  constructor() {
    super('A receive rotation requires a durable stageRotation checkpoint.');
  }
}

export type ReceiveBearerOptions = FundOperationOptions & {
  // the caller's durable allocation path for the rotation's fresh secret -
  // required when stageRotation is present
  readonly allocateOutputSecrets?: OutputSecretAllocator;
  // durably persist the future rotated note (unverified, pendingMint
  // carrying the original k1 as sourceRecoverySecret) before the rotate
  // reaches the mint. The record's fate is decided by the result's
  // `stage` disposition.
  readonly stageRotation?: (staged: NewBearer) => void | Promise<void>;
};

export type ReceivedNote = {
  readonly note: NewBearer;
  readonly rotated: boolean;
  readonly rotationError?: string;
  // how the caller disposes the staged rotation output:
  // - 'finalize': the rotate landed - replace the staged record with `note`
  // - 'keep': the outcome is genuinely ambiguous - the staged record IS
  //   the possible rotated copy, kept unverified alongside `note` (the
  //   original, demoted to unverified since its copy may be burned)
  // - 'discard': the rotate provably never landed - drop the staged
  //   record; `note` is the original, still verified as received
  // - 'none': no rotate was attempted (the note could not be verified) -
  //   nothing was staged
  readonly stage: 'finalize' | 'keep' | 'discard' | 'none';
};

// NoteSpentError / NoteUnknownError / PendingNoteError from the service are
// definitive and propagate; an unreachable service still yields the note,
// unverified, at the sender's declared amount.
export const receiveBearer = async (
  input: string,
  existing: Bearer[],
  options: ReceiveBearerOptions = {},
): Promise<ReceivedNote> => {
  // the forced mutation policy (see shared.ts) covers the rotate below
  const mutationOptions = withMutationSafety(options);
  const note = await receiveNote(input, existing);
  if (!note.verified || !note.callback) {
    return { note, rotated: false, stage: 'none' };
  }
  // the rotate burns the sender's secret at a fresh one: stage that future
  // note durably before the mutation can land, or a crash strands the money
  const staging = options.stageRotation;
  if (!staging) throw new ReceiveRotationStagingRequiredError();
  const [rotationSecret] = await requireOutputSecrets(
    options.allocateOutputSecrets,
    serverOf(note.url),
    1,
  );
  const staged: NewBearer = {
    url: withNewK1(note.url, rotationSecret, note.amount),
    callback: note.callback,
    amount: note.amount,
    verified: false,
    pendingMint: {
      sourceRecoverySecret: requireNoteK1(note.url),
      ...(note.mintPubkey ? { mintPubkey: note.mintPubkey } : {}),
    },
  };
  await staging(staged);
  const rotateOptions = { ...mutationOptions, randomSecret: () => rotationSecret };
  // the disposition the caller applies to its staged record
  const disposition = (rotated: boolean, ambiguous: boolean): ReceivedNote['stage'] => {
    if (rotated) return 'finalize';
    return ambiguous ? 'keep' : 'discard';
  };
  try {
    assertFundOwner(options);
    const rotatedUrl = await secureReceivedNote(note, rotateOptions);
    return { note: { ...note, url: rotatedUrl }, rotated: true, stage: disposition(true, false) };
  } catch (err) {
    // A classified rotate refusal can still be a LANDED rotate: the
    // callback is a GET and HTTP stacks retry GETs, so the service may
    // have executed the first attempt and refused this one as an
    // already-spent input. The refusal then proves the sender's copy is
    // burned and the carried fresh secret is the only money left - probe
    // it before believing the refusal.
    const carried = newSecretsOf(err);
    if (carried.length === 1 && !(err instanceof AmbiguousMutationError)) {
      const outcome = await probeMutationOutput(note.url, carried[0], mutationOptions);
      if (outcome === 'live') {
        return {
          note: { ...note, url: withNewK1(note.url, carried[0], note.amount) },
          rotated: true,
          stage: disposition(true, false),
        };
      }
      if (outcome === 'unknown') {
        return {
          // the sender's copy may be burned - it cannot stay verified; the
          // staged record is the possible rotated copy
          note: { ...note, verified: false },
          rotated: false,
          stage: disposition(false, true),
          rotationError: `${err instanceof Error ? err.message : String(err)} The refusal may have named a retry of a rotation that already landed - the possible rotated copy is tracked unverified alongside this one.`,
        };
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
      throw err;
    }
    if (err instanceof AmbiguousMutationError) {
      const outcome = await probeBurnedNote(note.url, mutationOptions);
      if (outcome === 'gone') {
        return {
          note: {
            ...note,
            url: withNewK1(note.url, err.newSecrets[0], note.amount),
          },
          rotated: true,
          stage: disposition(true, false),
        };
      }
      if (outcome === 'unknown') {
        return {
          note,
          rotated: false,
          stage: disposition(false, true),
          rotationError: `${err.message} The rotation may still have gone through - the possible rotated copy is tracked unverified alongside this one.`,
        };
      }
    }
    // a failed rotate never fails the receive - the note is money as it
    // is; the caller warns that it must be treated as exposed. The rotate
    // provably never landed, so the staged record is worthless.
    return {
      note,
      rotated: false,
      rotationError: err instanceof Error ? err.message : String(err),
      stage: disposition(false, false),
    };
  }
};
