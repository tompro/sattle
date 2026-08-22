import type { CarveResult } from '@/lnurlcash/ops';
import type { BearerChangeset } from '@/lnurlcash/storage';
import type { Bearer, NewBearer } from '@/lnurlcash/types';
import { TrustedMintPostCommitError } from '@/stores/wallet';
import type { WalletOwnerFence } from '@/stores/walletOwnerFence';

export type CarveWallet = {
  readonly bearers: readonly Bearer[];
  readonly addBearers: (notes: NewBearer[], ownerFence: WalletOwnerFence) => Promise<Bearer[]>;
  readonly applyChangeset: (
    changeset: BearerChangeset,
    ownerFence: WalletOwnerFence,
  ) => Promise<Bearer[]>;
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
// but not spent, or vice versa) would strand or double-show money. Hence a
// single changeset through the wallet's one-write boundary, never an
// add-then-markSpent sequence of separate writes.
export const commitCarve = async (
  wallet: CarveWallet,
  carve: CarveResult,
  context: CarveCommitContext,
): Promise<Bearer> => {
  const existing = wallet.bearers.find((bearer) => bearer.url === carve.note.url);
  const additions: NewBearer[] = [];
  if (!existing) additions.push(carve.note);
  if (carve.change) additions.push(carve.change);
  let added: Bearer[];
  try {
    added = await wallet.applyChangeset(
      {
        add: additions,
        markSpent: carve.consumed.map((bearer) => bearer.id),
      },
      context.ownerFence,
    );
  } catch (error) {
    if (!(error instanceof TrustedMintPostCommitError)) throw error;
    context.warn(error.message);
    added = error.committedBearers;
  }
  const committed = existing ?? added[0];
  if (!committed) throw new Error('The carved note was not tracked.');
  return committed;
};
