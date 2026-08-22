import { computed, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import { toBech32Lnurl } from 'lnurlcash-kit';

import { writeClipboard } from '@/capabilities/clipboard';
import { canShareText, shareText } from '@/capabilities/share';
import { ensureExactAmount, UncertainOutcomeError } from '@/lnurlcash/ops';
import type { Bearer } from '@/lnurlcash/types';
import { msatToSats, satsToMsat } from '@/lnurlcash/units';
import { useWalletStore } from '@/stores/wallet';
import { useActivityStore } from '@/stores/activity';
import type { WalletOwnerFence } from '@/stores/walletOwnerFence';
import { addCommittedBearers, commitCarve } from './walletCarveCommit';

type SendTokenProps = Readonly<{ modelValue: boolean }>;
type SendTokenEmit = {
  (event: 'update:modelValue', value: boolean): void;
  (event: 'sent'): void;
};

export const useSendTokenDialog = (props: SendTokenProps, emit: SendTokenEmit) => {
  const $q = useQuasar();
  const wallet = useWalletStore();
  const activity = useActivityStore();
  const toast = (type: 'positive' | 'negative' | 'warning' | 'info', message: string): void => {
    if (typeof $q.notify === 'function') {
      $q.notify({ type, message, position: 'top', timeout: 3000 });
    }
  };
  const warnCommitted = (message: string): void => toast('warning', message);
  const show = computed({
    get: () => props.modelValue,
    set: (value: boolean) => emit('update:modelValue', value),
  });
  const step = ref<'amount' | 'ready'>('amount');
  const amountSats = ref('');
  const preparing = ref(false);
  const removing = ref(false);
  const errorMessage = ref<string | null>(null);
  const prepared = ref<Bearer | null>(null);
  const revealed = ref(false);
  const formatSats = (sats: number): string =>
    sats.toLocaleString(undefined, { maximumFractionDigits: 3 });
  const parsedAmount = computed<number | null>(() => {
    const amount = Number(amountSats.value);
    return Number.isInteger(amount) && amount > 0 ? amount : null;
  });
  const amountError = computed<string | null>(() => {
    if (parsedAmount.value === null) return null;
    if (satsToMsat(parsedAmount.value) > wallet.balanceMsat) {
      return `That's more than your spendable balance (${formatSats(wallet.balanceSats)} sats).`;
    }
    return null;
  });
  const canPrepare = computed(
    () => parsedAmount.value !== null && amountError.value === null && !preparing.value,
  );
  const noteDisplayValue = computed(() =>
    prepared.value ? toBech32Lnurl(prepared.value.url) : '',
  );
  const canShare = canShareText();
  const reset = (): void => {
    step.value = 'amount';
    amountSats.value = '';
    preparing.value = false;
    removing.value = false;
    errorMessage.value = null;
    prepared.value = null;
    revealed.value = false;
  };
  watch(
    () => props.modelValue,
    (open) => {
      if (open) reset();
    },
  );
  const prepare = async (): Promise<void> => {
    const sats = parsedAmount.value;
    if (sats === null || amountError.value !== null) return;
    preparing.value = true;
    errorMessage.value = null;
    let ownerFence: WalletOwnerFence | undefined;
    try {
      ownerFence = wallet.captureOwnerFence();
      const carve = await ensureExactAmount(wallet.bearers, satsToMsat(sats), {
        assertOwner: ownerFence,
      });
      const note = await commitCarve(wallet, carve, { ownerFence, warn: warnCommitted });
      if (carve.change) {
        await activity.log(
          'split',
          `Prepared a ${formatSats(sats)} sat note to hand over.`,
          (error) => warnCommitted(error.message),
        );
      } else if (carve.consumed.length > 1) {
        await activity.log(
          'combine',
          `Combined notes into a ${formatSats(sats)} sat note.`,
          (error) => warnCommitted(error.message),
        );
      }
      prepared.value = note;
      revealed.value = false;
      step.value = 'ready';
    } catch (error) {
      if (error instanceof UncertainOutcomeError) {
        if (!ownerFence) throw error;
        await addCommittedBearers(wallet, error.possibleOutputs, {
          ownerFence,
          warn: warnCommitted,
        });
        await activity.log(
          'transfer',
          'A note preparation could not be confirmed - possible notes stored unverified.',
          (activityError) => warnCommitted(activityError.message),
        );
        errorMessage.value =
          "Couldn't confirm with the mint. Your original notes are untouched, and the possible new notes are stored unverified - refresh your wallet later to reconcile.";
        toast('warning', 'Preparation uncertain - see the notice in the dialog.');
        return;
      }
      const message = error instanceof Error ? error.message : 'Something went wrong.';
      errorMessage.value = message.startsWith('No mint holds enough')
        ? 'Not enough spendable balance to cover that amount.'
        : message;
      toast('negative', errorMessage.value);
    } finally {
      preparing.value = false;
    }
  };
  const copyNote = async (): Promise<void> => {
    try {
      await writeClipboard(noteDisplayValue.value);
      toast('positive', 'Note copied to clipboard.');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      toast('negative', "Couldn't copy - reveal the note and copy it manually.");
    }
  };
  const shareNote = async (): Promise<void> => {
    try {
      await shareText('sattle bearer note', noteDisplayValue.value);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      await copyNote();
    }
  };
  const finishRemove = async (): Promise<void> => {
    const note = prepared.value;
    if (!note) return;
    removing.value = true;
    try {
      await wallet.markSpent(note.id, wallet.captureOwnerFence());
      await activity.log(
        'spent',
        `Handed over a ${formatSats(msatToSats(note.amount))} sat note.`,
        (error) => warnCommitted(error.message),
      );
      toast('positive', 'Removed from your balance.');
      emit('sent');
      show.value = false;
    } catch (error) {
      toast('negative', error instanceof Error ? error.message : 'Something went wrong.');
    } finally {
      removing.value = false;
    }
  };
  const finishKeep = (): void => {
    toast('info', 'Note kept in your wallet.');
    show.value = false;
  };
  return {
    amountError,
    amountSats,
    canPrepare,
    canShare,
    copyNote,
    errorMessage,
    finishKeep,
    finishRemove,
    formatSats,
    msatToSats,
    noteDisplayValue,
    prepare,
    prepared,
    preparing,
    removing,
    revealed,
    shareNote,
    show,
    step,
    wallet,
  };
};
