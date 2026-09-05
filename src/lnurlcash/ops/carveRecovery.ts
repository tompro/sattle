// A merge failure can hide a landed mutation because callback GETs may be
// retried below the engine. This module owns the probes that distinguish a
// plain refusal from a live or still-uncertain wallet-chosen output.

import { AmbiguousMutationError, mergeNotes, newSecretsOf, probeBurnedNote } from 'lnurlcash-kit';
import type { Bearer } from '../types';
import type { FundOperationOptions } from './shared';
import { probeMutationOutput, UncertainOutcomeError } from './shared';

export type MergeOutcome = {
  readonly rescued: boolean;
  // the mint's signature over the combined note - present only when the
  // merge's own answer was seen; a rescued merge (lost answer, retried
  // twin) has none to offer
  readonly signature?: string;
};

export const mergeAmbiguitySafe = async (
  base: Bearer,
  k1s: string[],
  options: FundOperationOptions,
): Promise<MergeOutcome> => {
  try {
    const merged = await mergeNotes(base.callback, k1s, options);
    return { rescued: false, signature: merged.signature };
  } catch (error) {
    if (error instanceof AmbiguousMutationError) {
      const outcome = await probeBurnedNote(base.url, options);
      if (outcome === 'live') throw error;
      if (outcome === 'unknown') {
        throw new UncertainOutcomeError(
          'The merge may have gone through but could not be confirmed - its possible combined note was already staged unverified alongside the originals.',
          [],
        );
      }
      return { rescued: true };
    }
    const carried = newSecretsOf(error);
    if (carried.length !== 1) throw error;
    const outcome = await probeMutationOutput(base.url, carried[0], options);
    if (outcome === 'absent') throw error;
    if (outcome === 'unknown') {
      throw new UncertainOutcomeError(
        'The merge was refused, but the refusal may have named a retry that already landed - its possible combined note was already staged unverified alongside the originals.',
        [],
      );
    }
    return { rescued: true };
  }
};
