// allow: SIZE_OK — cohesive encrypted-bearer repository with one serialized mutation boundary.
import { computed, ref } from 'vue';
import { deriveCashSecret, noteK1, serverOf, withNewK1 } from 'lnurlcash-kit';
import type { CashNode } from 'lnurlcash-kit';

import {
  applyBearerChangeset,
  deleteBearerRecord,
  mergeBearers,
  persistBearer,
  readFundsRevision,
  readPendingJournal,
  reserveCashIndices,
} from '@/lnurlcash/storage';
import type { BearerChangeset } from '@/lnurlcash/storage';
import { lockTrustedMint } from '@/lnurlcash/trustedMints';
import type { Bearer, NewBearer } from '@/lnurlcash/types';
import { msatToSats } from '@/lnurlcash/units';
import { recoverPendingTransferSource } from '@/lnurlcash/ops';
import type { CarveResult } from '@/lnurlcash/ops';
import { recoverStagedMintOutput } from '@/lnurlcash/ops/mint';
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
  readonly requireCashRoot: () => CashNode;
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
      // a carve checkpoint is identified by its output secret, not the
      // whole URL: the landed phase's note carries the mint's signature in
      // the URL that the pre-wire staged phase could not have had yet
      const sameOutput = (bearer: Bearer, note: NewBearer): boolean => {
        const k1 = noteK1(note.url);
        return (
          k1 !== null &&
          serverOf(bearer.url) === serverOf(note.url) &&
          noteK1(bearer.url) === k1
        );
      };
      const staged = bearers.value.find((bearer) => sameOutput(bearer, carve.note));
      const change = carve.change;
      const additions: NewBearer[] = [];
      if (!staged) additions.push(carve.note);
      if (change && !bearers.value.some((bearer) => sameOutput(bearer, change))) {
        additions.push(change);
      }
      // the landed checkpoint re-reports the staged note with its landed
      // signature and verification state - refresh the record in place so
      // a replayed checkpoint is a no-op rather than a duplicate
      const upserts: Bearer[] = staged
        ? [{ ...staged, ...carve.note, id: staged.id, updatedAt: Date.now() }]
        : [];
      ownerFence();
      const next = await applyBearerChangeset(
        options.requireKey(),
        bearers.value,
        {
          add: additions,
          markSpent: carve.consumed.map((bearer) => bearer.id),
          upsert: upserts,
        },
        { beforeCommit: ownerFence },
      );
      const added = next.slice(0, additions.length);
      bearers.value = next;
      await lockCommittedBearers([...added, ...upserts]);
      const committed = upserts[0] ?? added[0];
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

  const reserveStagedMintSource = (
    stagedId: string,
    sourceId: string,
    sourceRecoverySecret: string,
    ownerFence: WalletOwnerFence,
  ): Promise<void> =>
    mutate(async () => {
      options.setAuxiliaryError('');
      const staged = bearers.value.find((bearer) => bearer.id === stagedId);
      const source = bearers.value.find((bearer) => bearer.id === sourceId);
      if (!staged || !source) throw new BearerNotFoundError();
      if (!staged.pendingMint) throw new Error('The wallet record is not a pending mint output.');
      if (source.spent) throw new Error('The source note is already reserved.');
      ownerFence();
      const linked: Bearer = {
        ...staged,
        pendingMint: {
          ...staged.pendingMint,
          sourceBearerId: source.id,
          sourceRecoverySecret,
        },
        updatedAt: Date.now(),
      };
      bearers.value = await applyBearerChangeset(
        options.requireKey(),
        bearers.value,
        { add: [], markSpent: [source.id], upsert: [linked] },
        { beforeCommit: ownerFence },
      );
    });

  const restoreStagedMintSource = (
    stagedId: string,
    note: NewBearer,
    ownerFence: WalletOwnerFence,
  ): Promise<void> =>
    mutate(async () => {
      const staged = bearers.value.find((bearer) => bearer.id === stagedId);
      if (!staged?.pendingMint?.sourceBearerId) throw new BearerNotFoundError();
      const recoveryK1 = noteK1(note.url);
      const existing = recoveryK1
        ? bearers.value.find(
            (bearer) =>
              bearer.id !== staged.id &&
              serverOf(bearer.url) === serverOf(note.url) &&
              noteK1(bearer.url) === recoveryK1,
          )
        : undefined;
      ownerFence();
      const additions = existing ? [] : [note];
      const next = await applyBearerChangeset(
        options.requireKey(),
        bearers.value,
        {
          add: additions,
          markSpent: [staged.pendingMint.sourceBearerId],
          remove: [staged.id],
          upsert: existing
            ? [{ ...existing, ...note, id: existing.id, updatedAt: Date.now() }]
            : [],
        },
        { beforeCommit: ownerFence },
      );
      bearers.value = next;
      const committed = existing
        ? next.find((bearer) => bearer.id === existing.id)
        : next[0];
      if (!committed) throw new BearerNotFoundError();
      await lockCommittedBearers([committed]);
    });

  const finalizeStagedMintOutput = async (
    id: string,
    note: NewBearer,
    ownerFence: WalletOwnerFence,
  ): Promise<void> =>
    mutate(async () => {
      options.setAuxiliaryError('');
      const current = bearers.value.find((bearer) => bearer.id === id);
      if (!current) throw new BearerNotFoundError();
      if (!current.pendingMint) {
        if (
          current.url === note.url &&
          current.callback === note.callback &&
          current.amount === note.amount &&
          current.verified === note.verified &&
          current.mintPubkey === note.mintPubkey
        ) {
          return;
        }
        throw new Error('The wallet record is not a pending mint output.');
      }
      const sourceBearerId = current.pendingMint.sourceBearerId;
      if (sourceBearerId && !bearers.value.some((bearer) => bearer.id === sourceBearerId)) {
        throw new BearerNotFoundError();
      }
      ownerFence();
      const confirmed: Bearer = {
        ...current,
        ...note,
        pendingMint: undefined,
        updatedAt: Date.now(),
      };
      const next = await applyBearerChangeset(
        options.requireKey(),
        bearers.value,
        {
          add: [],
          markSpent: sourceBearerId ? [sourceBearerId] : [],
          upsert: [confirmed],
        },
        { beforeCommit: ownerFence },
      );
      bearers.value = next;
      await lockCommittedBearers([confirmed]);
    });

  const finalizeSpentStagedMintOutput = (id: string, ownerFence: WalletOwnerFence): Promise<void> =>
    mutate(async () => {
      options.setAuxiliaryError('');
      const current = bearers.value.find((bearer) => bearer.id === id);
      if (!current) throw new BearerNotFoundError();
      if (!current.pendingMint) return;
      const sourceBearerId = current.pendingMint.sourceBearerId;
      ownerFence();
      const spent: Bearer = {
        ...current,
        pendingMint: undefined,
        spent: true,
        updatedAt: Date.now(),
      };
      bearers.value = await applyBearerChangeset(
        options.requireKey(),
        bearers.value,
        {
          add: [],
          markSpent: sourceBearerId ? [sourceBearerId] : [],
          upsert: [spent],
        },
        { beforeCommit: ownerFence },
      );
    });

  let recoveryRun: Promise<void> | null = null;
  const recoverPendingMints = (ownerFence: WalletOwnerFence): Promise<void> => {
    if (recoveryRun) return recoveryRun;
    recoveryRun = (async () => {
      for (const staged of [...bearers.value]) {
        if (!staged.pendingMint || staged.spent) continue;
        try {
          const recoverLinkedSource = async (): Promise<void> => {
            const sourceBearerId = staged.pendingMint?.sourceBearerId;
            if (!sourceBearerId) return;
            const source = bearers.value.find((bearer) => bearer.id === sourceBearerId);
            if (!source) throw new BearerNotFoundError();
            const sourceRecovery = await recoverPendingTransferSource(staged, source, {
              assertOwner: ownerFence,
            });
            switch (sourceRecovery.state) {
              case 'pending':
                break;
              case 'returned':
                await restoreStagedMintSource(staged.id, sourceRecovery.note, ownerFence);
                break;
              case 'spent':
                await finalizeSpentStagedMintOutput(staged.id, ownerFence);
                break;
            }
          };
          const recovered = await recoverStagedMintOutput(staged, { assertOwner: ownerFence });
          switch (recovered.state) {
            case 'unminted':
              if (
                !staged.pendingMint.sourceBearerId &&
                staged.pendingMint.retireAfter !== undefined &&
                staged.pendingMint.retireAfter <= Math.floor(Date.now() / 1000)
              ) {
                await removeNote(staged.id, ownerFence);
                break;
              }
              if (
                !staged.pendingMint.sourceBearerId &&
                staged.pendingMint.sourceRecoverySecret
              ) {
                // a receive rotation that never landed: nothing exists at
                // the staged secret, so the note is restored at the
                // original k1 it was received on (journal GC below retires
                // the allocation record separately)
                await finalizeStagedMintOutput(
                  staged.id,
                  {
                    url: withNewK1(
                      staged.url,
                      staged.pendingMint.sourceRecoverySecret,
                      staged.amount,
                    ),
                    callback: staged.callback,
                    amount: staged.amount,
                    verified: true,
                    ...(staged.pendingMint.mintPubkey
                      ? { mintPubkey: staged.pendingMint.mintPubkey }
                      : {}),
                  },
                  ownerFence,
                );
                break;
              }
              await recoverLinkedSource();
              break;
            case 'pending':
              await recoverLinkedSource();
              break;
            case 'minted':
              await finalizeStagedMintOutput(staged.id, recovered.note, ownerFence);
              break;
            case 'spent':
              await finalizeSpentStagedMintOutput(staged.id, ownerFence);
              break;
          }
        } catch (error) {
          ownerFence();
          if (staged.pendingMint.sourceBearerId) {
            try {
              const source = bearers.value.find(
                (bearer) => bearer.id === staged.pendingMint?.sourceBearerId,
              );
              if (!source) throw new BearerNotFoundError();
              const sourceRecovery = await recoverPendingTransferSource(staged, source, {
                assertOwner: ownerFence,
              });
              if (sourceRecovery.state === 'returned') {
                await restoreStagedMintSource(staged.id, sourceRecovery.note, ownerFence);
                continue;
              }
            } catch (sourceError) {
              ownerFence();
              if (sourceError instanceof TrustedMintPostCommitError) {
                options.setAuxiliaryError(sourceError.message);
                continue;
              }
            }
          }
          options.setAuxiliaryError(
            error instanceof TrustedMintPostCommitError
              ? error.message
              : 'A pending mint output could not be refreshed. It will be retried later.',
          );
        }
      }
      // Retire cash-allocation journal records: their secrets are either
      // already carried by staged bearer records (the operative journal)
      // or never reached a mint (staging always precedes the wire), so the
      // records are crash-window proofs, safe to clear once recovery has
      // reconciled the bearer side. The counter bump they document is
      // permanent either way - burned indices are never reused.
      try {
        const staleAllocationIds = readPendingJournal()
          .filter((record) => record.kind === 'cash-allocation')
          .map((record) => record.id);
        if (staleAllocationIds.length > 0) {
          await applyChangeset(
            { add: [], markSpent: [], clearPending: staleAllocationIds },
            ownerFence,
          );
        }
      } catch (error) {
        ownerFence();
        options.setAuxiliaryError(
          'Pending allocation records could not be cleared. They will be retired later.',
        );
      }
    })().finally(() => {
      recoveryRun = null;
    });
    return recoveryRun;
  };

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

  // The operation-facing allocation path: the ops engine asks for exactly
  // the output secrets it is about to stage, keyed by the mint's canonical
  // host, and the reservation (counter bump + encrypted journal record)
  // commits before any of them can reach the wire. The cash root never
  // leaves the wallet store - it is re-read from the unlocked material per
  // call.
  const allocateOutputSecrets = (
    server: string,
    count: number,
    ownerFence: WalletOwnerFence,
  ): Promise<readonly string[]> =>
    allocateCashSecrets(options.requireCashRoot(), server, count, ownerFence).then(
      (allocated) => allocated.secrets,
    );

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
      reserveStagedMintSource,
      restoreStagedMintSource,
      finalizeStagedMintOutput,
      finalizeSpentStagedMintOutput,
      recoverPendingMints,
      allocateCashSecrets,
      allocateOutputSecrets,
      markSpent,
      removeNote,
      mergeExternalBearers,
    },
    replace,
    clear,
  };
};
