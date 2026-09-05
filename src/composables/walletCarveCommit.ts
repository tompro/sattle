import type { CarveResult } from '@/lnurlcash/ops';
import type { Bearer, NewBearer } from '@/lnurlcash/types';
import { TrustedMintPostCommitError } from '@/stores/wallet';
import type { WalletOwnerFence } from '@/stores/walletOwnerFence';

export type CarveWallet = {
  readonly bearers: readonly Bearer[];
  readonly addBearers: (notes: NewBearer[], ownerFence: WalletOwnerFence) => Promise<Bearer[]>;
  readonly commitCarve: (carve: CarveResult, ownerFence: WalletOwnerFence) => Promise<Bearer>;
};

type CarveCommitContext = Readonly<{
  ownerFence: WalletOwnerFence;
  warn: (message: string) => void;
}>;

export const addCommittedBearers = async (
  wallet: CarveWallet,
  notes: NewBearer[],
  context: CarveCommitContext,
): Promise<Bearer[]> => {
  try {
    return await wallet.addBearers(notes, context.ownerFence);
  } catch (error) {
    if (!(error instanceof TrustedMintPostCommitError)) throw error;
    context.warn(error.message);
    return error.committedBearers;
  }
};

// A carve is ONE logical rotation: the fresh notes (target + change) and the
// spent marks of the burned inputs must land together or not at all - the
// mint already destroyed the inputs server-side, so a partial commit (added
// but not spent, or vice versa) would strand or double-show money. Both
// checkpoint phases (pre-wire staging, landed retirement) go through the
// wallet's k1-aware one-write boundary: the landed phase's URLs carry the
// mint's signature the staged phase's could not have, so the store matches
// checkpoints by output SECRET and refreshes the staged record in place -
// a replayed checkpoint is a no-op, never a duplicate.
export const commitCarve = async (
  wallet: CarveWallet,
  carve: CarveResult,
  context: CarveCommitContext,
): Promise<Bearer> => {
  try {
    return await wallet.commitCarve(carve, context.ownerFence);
  } catch (error) {
    if (!(error instanceof TrustedMintPostCommitError)) throw error;
    context.warn(error.message);
    const committed = error.committedBearers[0];
    if (!committed) throw error;
    return committed;
  }
};
