import { computed, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import { useRouter } from 'vue-router';
import {
  NoteSpentError,
  NoteUnknownError,
  PendingNoteError,
  noteK1,
  serverOf,
} from 'lnurlcash-kit';

import { compareBearerOrder } from '@/lnurlcash/storage';
import { ensureExactAmount, receiveBearer, UncertainOutcomeError } from '@/lnurlcash/ops';
import { getTrustedMintVerificationKeys } from '@/lnurlcash/trustedMints';
import type { Bearer } from '@/lnurlcash/types';
import { msatToSats, satsToMsat } from '@/lnurlcash/units';
import { useActivityStore } from '@/stores/activity';
import { TrustedMintPostCommitError, useWalletStore } from '@/stores/wallet';
import { addCommittedBearers, commitCarve } from './walletCarveCommit';

export const useNotesPage = () => {
  const router = useRouter();
  const $q = useQuasar();
  const wallet = useWalletStore();
  const activity = useActivityStore();
  const selectedIds = ref<string[]>([]);
  const detail = ref<Bearer | null>(null);
  const splitOpen = ref(false);
  const splitAmount = ref<number | null>(null);
  const busy = ref(false);

  const notify = (type: 'positive' | 'negative' | 'warning', message: string): void => {
    $q.notify({ type, message, position: 'top', timeout: 3500 });
  };
  const warnCommitted = (message: string): void => notify('warning', message);
  const notes = computed(() => [...wallet.bearers].sort(compareBearerOrder));
  const selectedNotes = computed(() =>
    selectedIds.value
      .map((id) => wallet.bearers.find((note) => note.id === id))
      .filter((note): note is Bearer => note !== undefined),
  );
  const canMutate = (note: Bearer): boolean =>
    note.verified &&
    !note.spent &&
    !note.pendingMint &&
    !note.deviceId &&
    note.callback !== '' &&
    noteK1(note.url) !== null;
  const canMerge = computed(() => {
    if (selectedNotes.value.length < 2 || selectedNotes.value.some((note) => !canMutate(note))) {
      return false;
    }
    const first = selectedNotes.value[0];
    if (!first) return false;
    const server = serverOf(first.url);
    return selectedNotes.value.every((note) => serverOf(note.url) === server);
  });
  const formatSats = (amountMsat: number): string =>
    msatToSats(amountMsat).toLocaleString(undefined, { maximumFractionDigits: 3 });
  const status = (note: Bearer): string => {
    if (note.spent) return 'Spent';
    if (note.pendingMint) return 'Pending';
    if (note.deviceId) return 'Paired device';
    return note.verified ? 'Valid locally' : 'Unverified';
  };
  const statusColor = (note: Bearer): string => {
    if (note.spent) return 'grey-6';
    if (note.pendingMint) return 'warning';
    return note.verified ? 'positive' : 'warning';
  };

  watch(
    () => wallet.state,
    (state) => {
      if (state !== 'unlocked') void router.replace('/');
    },
    { immediate: true },
  );
  watch(
    () => wallet.bearers,
    () => {
      selectedIds.value = selectedIds.value.filter((id) => wallet.bearers.some((n) => n.id === id));
      if (detail.value)
        detail.value = wallet.bearers.find((n) => n.id === detail.value?.id) ?? null;
    },
  );

  const carve = async (inputs: Bearer[], amountMsat: number, kind: 'split' | 'combine') => {
    busy.value = true;
    let operation: ReturnType<typeof wallet.beginFundOperation> | undefined;
    try {
      operation = wallet.beginFundOperation();
      const ownerFence = operation.ownerFence;
      const ownerId = wallet.pubkey ?? undefined;
      const result = await ensureExactAmount(inputs, amountMsat, {
        assertOwner: ownerFence,
        allocateOutputSecrets: (server, count) =>
          wallet.allocateOutputSecrets(server, count, ownerFence),
        mintSignatureKeys: (server) => getTrustedMintVerificationKeys(server, ownerId),
        onCarve: async (checkpoint) => {
          await commitCarve(wallet, checkpoint, { ownerFence, warn: warnCommitted });
        },
      });
      await activity.log(
        kind,
        kind === 'combine'
          ? `Combined ${inputs.length} notes into ${formatSats(result.note.amount)} sats.`
          : `Split a note into ${formatSats(result.note.amount)} and ${formatSats(result.change?.amount ?? 0)} sats.`,
        (error) => warnCommitted(error.message),
      );
      selectedIds.value = [];
      splitOpen.value = false;
      detail.value = null;
      notify('positive', kind === 'combine' ? 'Notes combined.' : 'Note split.');
    } catch (error) {
      if (error instanceof UncertainOutcomeError && operation) {
        await addCommittedBearers(wallet, error.possibleOutputs, {
          ownerFence: operation.ownerFence,
          warn: warnCommitted,
        });
        notify('warning', 'The mint result is uncertain. Possible outputs are saved unverified.');
      } else {
        notify('negative', error instanceof Error ? error.message : 'The note operation failed.');
      }
    } finally {
      operation?.complete();
      busy.value = false;
    }
  };

  const mergeSelected = (): Promise<void> => {
    if (!canMerge.value) return Promise.resolve();
    return carve(
      selectedNotes.value,
      selectedNotes.value.reduce((total, note) => total + note.amount, 0),
      'combine',
    );
  };
  const openSplit = (note: Bearer): void => {
    detail.value = note;
    splitAmount.value = null;
    splitOpen.value = true;
  };
  const confirmSplit = (): Promise<void> => {
    const note = detail.value;
    const sats = splitAmount.value;
    if (!note || !sats || !Number.isInteger(sats) || satsToMsat(sats) >= note.amount) {
      notify('negative', 'Enter a whole-sat amount smaller than the note.');
      return Promise.resolve();
    }
    return carve([note], satsToMsat(sats), 'split');
  };

  const refreshNote = async (note: Bearer): Promise<void> => {
    if (note.spent || note.pendingMint || note.deviceId || !noteK1(note.url)) return;
    busy.value = true;
    let operation: ReturnType<typeof wallet.beginFundOperation> | undefined;
    let staged: Bearer | undefined;
    let refreshReturned = false;
    try {
      operation = wallet.beginFundOperation();
      const ownerFence = operation.ownerFence;
      const refreshed = await receiveBearer(
        note.url,
        wallet.bearers.filter((candidate) => candidate.id !== note.id),
        {
          assertOwner: ownerFence,
          allocateOutputSecrets: (server, count) =>
            wallet.allocateOutputSecrets(server, count, ownerFence),
          stageRotation: async (output) => {
            [staged] = await addCommittedBearers(
              wallet,
              [
                {
                  ...output,
                  amount: 0,
                  label: note.label,
                  pendingMint: { ...output.pendingMint, refreshSourceBearerId: note.id },
                },
              ],
              { ownerFence, warn: warnCommitted },
            );
          },
        },
      );
      refreshReturned = true;
      if (refreshed.stage === 'finalize') {
        if (!staged) throw new Error('The refreshed note was not staged.');
        try {
          await wallet.finalizeStagedMintOutput(staged.id, refreshed.note, ownerFence);
        } catch (error) {
          if (!(error instanceof TrustedMintPostCommitError)) throw error;
          warnCommitted(error.message);
        }
      } else if (refreshed.stage === 'discard') {
        if (staged) await wallet.removeNote(staged.id, ownerFence);
        await wallet.updateBearer(
          note.id,
          {
            callback: refreshed.note.callback,
            amount: refreshed.note.amount,
            verified: refreshed.note.verified,
            mintPubkey: refreshed.note.mintPubkey,
          },
          ownerFence,
        );
      } else if (refreshed.stage === 'keep') {
        await wallet.updateBearer(note.id, { verified: false }, ownerFence);
      } else {
        await wallet.updateBearer(
          note.id,
          {
            callback: refreshed.note.callback,
            amount: refreshed.note.amount,
            verified: refreshed.note.verified,
          },
          ownerFence,
        );
      }
      await activity.log(
        'refresh',
        `Checked and refreshed a ${formatSats(refreshed.note.amount)} sat note from ${serverOf(note.url)}.`,
        (error) => warnCommitted(error.message),
      );
      detail.value = wallet.bearers.find((candidate) => candidate.id === note.id) ?? null;
      notify(
        refreshed.rotated ? 'positive' : 'warning',
        refreshed.rotated
          ? 'Note is valid and has a fresh secret.'
          : 'Note checked, but could not be rotated.',
      );
    } catch (error) {
      if ((error instanceof NoteSpentError || error instanceof NoteUnknownError) && operation) {
        try {
          await wallet.applyChangeset(
            {
              add: [],
              markSpent: [note.id],
              ...(staged ? { remove: [staged.id] } : {}),
            },
            operation.ownerFence,
          );
          notify(
            'negative',
            error instanceof NoteSpentError
              ? 'The mint reports this note spent.'
              : 'The mint does not know this note.',
          );
        } catch (commitError) {
          notify(
            'negative',
            commitError instanceof Error ? commitError.message : 'Could not save the note status.',
          );
        }
      } else if (error instanceof PendingNoteError) {
        if (staged && operation) {
          await wallet.removeNote(staged.id, operation.ownerFence).catch(() => undefined);
        }
        notify('warning', 'The note is temporarily locked by a pending payment.');
      } else {
        if (staged && operation && !refreshReturned) {
          await wallet.removeNote(staged.id, operation.ownerFence).catch(() => undefined);
        }
        notify('negative', error instanceof Error ? error.message : 'The validity check failed.');
      }
    } finally {
      operation?.complete();
      busy.value = false;
    }
  };

  const saveLabel = async (note: Bearer, label: string): Promise<void> => {
    const operation = wallet.beginFundOperation();
    try {
      await wallet.updateBearer(
        note.id,
        { label: label.trim() || undefined },
        operation.ownerFence,
      );
      notify('positive', 'Label saved.');
    } catch (error) {
      notify('negative', error instanceof Error ? error.message : 'Could not save the label.');
    } finally {
      operation.complete();
    }
  };
  const moveNote = (note: Bearer): void => {
    void router.push({ path: '/settings/move', query: { noteId: note.id } });
  };

  return {
    busy,
    canMerge,
    canMutate,
    confirmSplit,
    detail,
    formatSats,
    mergeSelected,
    moveNote,
    notes,
    openSplit,
    refreshNote,
    router,
    saveLabel,
    selectedIds,
    serverOf,
    splitAmount,
    splitOpen,
    status,
    statusColor,
  };
};
