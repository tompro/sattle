import { computed, ref } from 'vue';
import { serverOf } from 'lnurlcash-kit';

import {
  applyBearerChangeset,
  deleteBearerRecord,
  loadBearers,
  mergeBearers,
  persistBearer,
} from '@/lnurlcash/storage';
import type { BearerChangeset } from '@/lnurlcash/storage';
import { lockTrustedMint } from '@/lnurlcash/trustedMints';
import type { Bearer, NewBearer } from '@/lnurlcash/types';
import { msatToSats } from '@/lnurlcash/units';
import type { WalletOwnerFence } from './walletOwnerFence';

export class TrustedMintPostCommitError extends Error {
  override readonly name = 'TrustedMintPostCommitError';
  readonly fundsCommitted = true;

  constructor(
    readonly committedBearers: Bearer[],
    options: { cause: unknown },
  ) {
    super(
      'Funds were saved, but the trusted-mint registry could not be updated. The receive succeeded; do not retry it.',
      options,
    );
  }
}

type WalletFundsOptions = {
  readonly requireKey: () => CryptoKey;
  readonly ownerId: () => string | undefined;
  readonly setAuxiliaryError: (message: string) => void;
};

export const createWalletFunds = (options: WalletFundsOptions) => {
  const bearers = ref<Bearer[]>([]);
  const unspentBearers = computed(() => bearers.value.filter((bearer) => !bearer.spent));
  const balanceMsat = computed(() =>
    unspentBearers.value.reduce((sum, bearer) => sum + bearer.amount, 0),
  );
  const balanceSats = computed(() => msatToSats(balanceMsat.value));
  const balanceByMintMsat = computed(() => {
    const byMint = new Map<string, number>();
    for (const bearer of unspentBearers.value) {
      const server = serverOf(bearer.url);
      byMint.set(server, (byMint.get(server) ?? 0) + bearer.amount);
    }
    return byMint;
  });
  const balanceByMintSats = computed(() => {
    const byMint = new Map<string, number>();
    for (const [server, msat] of balanceByMintMsat.value) {
      byMint.set(server, msatToSats(msat));
    }
    return byMint;
  });

  const replace = (loaded: Bearer[]): void => {
    bearers.value = loaded;
  };

  const clear = (): void => {
    bearers.value = [];
  };

  const lockCommittedBearers = async (committed: Bearer[]): Promise<void> => {
    try {
      for (const bearer of committed) {
        if (bearer.mintPubkey) {
          await lockTrustedMint(serverOf(bearer.url), bearer.mintPubkey, options.ownerId());
        }
      }
    } catch (error) {
      const cause = error instanceof Error ? error : new Error('Trusted-mint update failed.');
      const postCommitError = new TrustedMintPostCommitError(committed, { cause });
      options.setAuxiliaryError(postCommitError.message);
      throw postCommitError;
    }
  };

  const addBearers = async (
    notes: NewBearer[],
    ownerFence: WalletOwnerFence,
  ): Promise<Bearer[]> => {
    options.setAuxiliaryError('');
    ownerFence();
    const next = await applyBearerChangeset(
      options.requireKey(),
      bearers.value,
      { add: notes, markSpent: [] },
      // re-prove ownership inside the lock: encryption is async, so the
      // entry check alone would leave a cross-tab replacement window open
      { beforeCommit: ownerFence },
    );
    const added = next.slice(0, notes.length);
    bearers.value = next;
    await lockCommittedBearers(added);
    return added;
  };

  const applyChangeset = async (
    changeset: BearerChangeset,
    ownerFence: WalletOwnerFence,
  ): Promise<Bearer[]> => {
    options.setAuxiliaryError('');
    ownerFence();
    const next = await applyBearerChangeset(options.requireKey(), bearers.value, changeset, {
      beforeCommit: ownerFence,
    });
    const added = next.slice(0, changeset.add.length);
    bearers.value = next;
    await lockCommittedBearers(added);
    return added;
  };

  const updateBearer = async (
    id: string,
    changes: Partial<Omit<Bearer, 'id'>>,
    ownerFence: WalletOwnerFence,
  ): Promise<void> => {
    options.setAuxiliaryError('');
    const current = bearers.value.find((bearer) => bearer.id === id);
    if (!current) return;
    ownerFence();
    const updated: Bearer = { ...current, ...changes, updatedAt: Date.now() };
    await persistBearer(options.requireKey(), updated, { beforeCommit: ownerFence });
    bearers.value = bearers.value.map((bearer) => (bearer.id === id ? updated : bearer));
    if (!updated.mintPubkey) return;
    try {
      await lockTrustedMint(serverOf(updated.url), updated.mintPubkey, options.ownerId());
    } catch (error) {
      const cause = error instanceof Error ? error : new Error('Trusted-mint update failed.');
      const postCommitError = new TrustedMintPostCommitError([updated], { cause });
      options.setAuxiliaryError(postCommitError.message);
      throw postCommitError;
    }
  };

  const markSpent = async (
    id: string,
    ownerFence: WalletOwnerFence,
    spent = true,
  ): Promise<void> => {
    await updateBearer(id, { spent }, ownerFence);
  };

  const removeNote = async (id: string, ownerFence: WalletOwnerFence): Promise<void> => {
    ownerFence();
    await deleteBearerRecord(id, { beforeCommit: ownerFence });
    bearers.value = bearers.value.filter((bearer) => bearer.id !== id);
  };

  const mergeExternalBearers = async (
    incoming: Bearer[],
    ownerFence: WalletOwnerFence,
  ): Promise<void> => {
    ownerFence();
    const merged = mergeBearers(bearers.value, incoming);
    const mergedIds = new Set(merged.map((bearer) => bearer.id));
    await applyBearerChangeset(
      options.requireKey(),
      bearers.value,
      {
        add: [],
        markSpent: [],
        upsert: merged,
        remove: bearers.value.filter((bearer) => !mergedIds.has(bearer.id)).map(({ id }) => id),
      },
      { beforeCommit: ownerFence },
    );
    bearers.value = merged;
  };

  const reloadBearers = async (): Promise<void> => {
    bearers.value = await loadBearers(options.requireKey());
  };

  return {
    public: {
      bearers,
      unspentBearers,
      balanceMsat,
      balanceSats,
      balanceByMintMsat,
      balanceByMintSats,
      addBearers,
      applyChangeset,
      updateBearer,
      markSpent,
      removeNote,
      mergeExternalBearers,
      reloadBearers,
    },
    replace,
    clear,
  };
};
