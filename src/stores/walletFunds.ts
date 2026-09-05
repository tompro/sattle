// allow: SIZE_OK — cohesive encrypted-bearer repository with one serialized mutation boundary.
import { computed, ref } from 'vue';
import { deriveCashSecret, serverOf } from 'lnurlcash-kit';
import type { CashNode } from 'lnurlcash-kit';

import {
  applyBearerChangeset,
  deleteBearerRecord,
  mergeBearers,
  persistBearer,
  readFundsRevision,
  reserveCashIndices,
} from '@/lnurlcash/storage';
import type { BearerChangeset } from '@/lnurlcash/storage';
import { lockTrustedMint } from '@/lnurlcash/trustedMints';
import type { Bearer, NewBearer } from '@/lnurlcash/types';
import { msatToSats } from '@/lnurlcash/units';
import type { CarveResult } from '@/lnurlcash/ops';
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

export class BearerNotFoundError extends Error {
  override readonly name = 'BearerNotFoundError';

  constructor() {
    super('The wallet record no longer exists.');
  }
}

// the result of one atomic counter reservation: the assigned BIP-32 index
// range, the secrets derived at those indices, and the staged journal record
// that makes the reservation recoverable after a crash
export type AllocatedCashSecrets = {
  readonly host: string;
  readonly start: number;
  readonly secrets: string[];
  readonly pendingId: string;
};

type WalletFundsOptions = {
  readonly requireKey: () => CryptoKey;
  readonly ownerId: () => string | undefined;
  readonly setAuxiliaryError: (message: string) => void;
};

export const createWalletFunds = (options: WalletFundsOptions) => {
  const bearers = ref<Bearer[]>([]);
  // reactive mirror of the persisted document revision: counter-only commits
  // (reservations) don't touch the bearer list, so nostr backup scheduling
  // watches this instead of inferring change from the notes alone
  const fundsRevision = ref(0);
  const syncRevision = (): void => {
    fundsRevision.value = readFundsRevision();
  };
  let mutationTail: Promise<void> = Promise.resolve();
  const mutate = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    // a post-commit failure (trusted-mint update) still bumped the persisted
    // revision, so refresh on settle, not just on success
    void result.then(syncRevision, syncRevision);
    return result;
  };
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
    syncRevision();
  };

  const clear = (): void => {
    bearers.value = [];
    fundsRevision.value = 0;
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

  const addBearers = async (notes: NewBearer[], ownerFence: WalletOwnerFence): Promise<Bearer[]> =>
    mutate(async () => {
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
    });

  const applyChangeset = async (
    changeset: BearerChangeset,
    ownerFence: WalletOwnerFence,
  ): Promise<Bearer[]> =>
    mutate(async () => {
      options.setAuxiliaryError('');
      ownerFence();
      const next = await applyBearerChangeset(options.requireKey(), bearers.value, changeset, {
        beforeCommit: ownerFence,
      });
      const added = next.slice(0, changeset.add.length);
      bearers.value = next;
      await lockCommittedBearers(added);
      return added;
    });

  const commitCarve = (carve: CarveResult, ownerFence: WalletOwnerFence): Promise<Bearer> =>
    mutate(async () => {
      const existing = bearers.value.find((bearer) => bearer.url === carve.note.url);
      const additions: NewBearer[] = [];
      if (!existing) additions.push(carve.note);
      if (carve.change) additions.push(carve.change);
      ownerFence();
      const next = await applyBearerChangeset(
        options.requireKey(),
        bearers.value,
        {
          add: additions,
          markSpent: carve.consumed.map((bearer) => bearer.id),
        },
        { beforeCommit: ownerFence },
      );
      const added = next.slice(0, additions.length);
      bearers.value = next;
      await lockCommittedBearers(added);
      const committed = existing ?? added[0];
      if (!committed) throw new Error('The carved note was not tracked.');
      return committed;
    });

  const updateBearer = async (
    id: string,
    changes: Partial<Omit<Bearer, 'id'>>,
    ownerFence: WalletOwnerFence,
  ): Promise<void> =>
    mutate(async () => {
      options.setAuxiliaryError('');
      const current = bearers.value.find((bearer) => bearer.id === id);
      if (!current) throw new BearerNotFoundError();
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
    });

  const markSpent = async (
    id: string,
    ownerFence: WalletOwnerFence,
    spent = true,
  ): Promise<void> => {
    await updateBearer(id, { spent }, ownerFence);
  };

  const removeNote = async (id: string, ownerFence: WalletOwnerFence): Promise<void> =>
    mutate(async () => {
      ownerFence();
      await deleteBearerRecord(id, { beforeCommit: ownerFence });
      bearers.value = bearers.value.filter((bearer) => bearer.id !== id);
    });

  const mergeExternalBearers = async (
    incoming: Bearer[],
    ownerFence: WalletOwnerFence,
  ): Promise<void> =>
    mutate(async () => {
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
    });

  // Reserves `count` fresh BIP-32 cash secrets for a canonical mint host and
  // stages the reservation in the pending journal - allocation plus staging
  // land in ONE locked document write (see lnurlcash/storage/bearers.ts), so
  // a crash after this resolves can neither double-spend an index nor lose
  // the staged secrets. The cash root stays a caller-supplied parameter: this
  // store never holds key material it doesn't need persistently. Secrets are
  // derived inside the storage lock (the range only exists once serialized)
  // and returned to the caller; they are never logged.
  const allocateCashSecrets = (
    cashRoot: CashNode,
    host: string,
    count: number,
    ownerFence: WalletOwnerFence,
  ): Promise<AllocatedCashSecrets> =>
    mutate(async () => {
      options.setAuxiliaryError('');
      ownerFence();
      let secrets: string[] = [];
      const reserved = await reserveCashIndices(
        options.requireKey(),
        { host, count },
        ({ host: reservedHost, start, count: reservedCount }) => {
          secrets = Array.from({ length: reservedCount }, (_, offset) =>
            deriveCashSecret(cashRoot, reservedHost, start + offset),
          );
          return {
            kind: 'cash-allocation',
            phase: 'reserved',
            payload: { host: reservedHost, start, count: reservedCount, secrets },
          };
        },
        { beforeCommit: ownerFence },
      );
      return {
        host: reserved.host,
        start: reserved.start,
        secrets,
        pendingId: reserved.pendingId,
      };
    });

  return {
    public: {
      bearers,
      fundsRevision,
      unspentBearers,
      balanceMsat,
      balanceSats,
      balanceByMintMsat,
      balanceByMintSats,
      addBearers,
      applyChangeset,
      commitCarve,
      updateBearer,
      allocateCashSecrets,
      markSpent,
      removeNote,
      mergeExternalBearers,
    },
    replace,
    clear,
  };
};
