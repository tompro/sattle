import { computed, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import { decodeBolt11AmountMsat, isBolt11Invoice, resolveLnurlInput } from 'lnurlcash-kit';

import { readClipboard } from '@/capabilities/clipboard';
import { payWithBearers, UncertainOutcomeError } from '@/lnurlcash/ops';
import type { PayOutcome } from '@/lnurlcash/ops';
import { msatToSats, satsToMsat } from '@/lnurlcash/units';
import { useWalletStore } from '@/stores/wallet';
import { useActivityStore } from '@/stores/activity';
import type { WalletOwnerFence } from '@/stores/walletOwnerFence';
import { addCommittedBearers, commitCarve } from './walletCarveCommit';

type PayInvoiceProps = Readonly<{ modelValue: boolean; initialInput?: string }>;
type PayInvoiceEmit = {
  (event: 'update:modelValue', value: boolean): void;
  (event: 'sent'): void;
};
type TargetKind = 'invoice' | 'address';
type PendingPayment = Readonly<{ kind: TargetKind; input: string; amountMsat: number }>;
type PaymentResult = Readonly<{ outcome: PayOutcome; amountMsat: number }>;

export const usePayInvoiceDialog = (props: PayInvoiceProps, emit: PayInvoiceEmit) => {
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
  const step = ref<'input' | 'confirm' | 'working' | 'result'>('input');
  const input = ref('');
  const addressAmountSats = ref('');
  const showScanner = ref(false);
  const inlineError = ref<string | null>(null);
  const stage = ref('');
  const pendingPayment = ref<PendingPayment | null>(null);
  const result = ref<PaymentResult | null>(null);
  const formatSats = (sats: number): string =>
    sats.toLocaleString(undefined, { maximumFractionDigits: 3 });
  const classify = (value: string): TargetKind | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (isBolt11Invoice(trimmed)) return 'invoice';
    return resolveLnurlInput(trimmed) === null ? null : 'address';
  };
  const targetKind = computed<TargetKind | null>(() => classify(input.value));
  const truncatedInput = computed(() => {
    const payment = pendingPayment.value;
    if (!payment) return '';
    if (payment.kind === 'address') return payment.input;
    return payment.input.length > 30
      ? `${payment.input.slice(0, 18)}…${payment.input.slice(-8)}`
      : payment.input;
  });
  const resultAmountSats = computed(() =>
    result.value ? formatSats(msatToSats(result.value.amountMsat)) : '',
  );
  const reset = (): void => {
    step.value = 'input';
    input.value = props.initialInput ?? '';
    addressAmountSats.value = '';
    showScanner.value = false;
    inlineError.value = null;
    stage.value = '';
    pendingPayment.value = null;
    result.value = null;
  };
  watch(
    () => props.modelValue,
    (open) => {
      if (open) reset();
    },
  );
  const onScan = (text: string): void => {
    input.value = text.replace(/^lightning:/i, '').trim();
    showScanner.value = false;
  };
  const onScanError = (message: string): void => {
    showScanner.value = false;
    toast('negative', message);
  };
  const paste = async (): Promise<void> => {
    try {
      const text = await readClipboard();
      if (text) input.value = text.trim();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      toast('negative', "Couldn't read the clipboard - paste manually.");
    }
  };
  const proceed = (): void => {
    inlineError.value = null;
    const value = input.value.trim();
    if (!value) {
      inlineError.value = 'Paste an invoice or a Lightning Address first.';
      return;
    }
    const kind = classify(value);
    if (kind === null) {
      inlineError.value = "That doesn't look like a Lightning invoice or address.";
      return;
    }
    let amountMsat: number;
    if (kind === 'invoice') {
      const decoded = decodeBolt11AmountMsat(value);
      if (decoded === null || decoded <= 0) {
        inlineError.value = "This invoice doesn't have an amount, which this wallet can't pay yet.";
        return;
      }
      amountMsat = decoded;
    } else {
      const sats = Number(addressAmountSats.value);
      if (!Number.isInteger(sats) || sats <= 0) {
        inlineError.value = 'Enter how many sats to send to this address.';
        return;
      }
      amountMsat = satsToMsat(sats);
    }
    if (amountMsat > wallet.balanceMsat) {
      inlineError.value = `That's more than your spendable balance (${formatSats(wallet.balanceSats)} sats).`;
      return;
    }
    pendingPayment.value = { kind, input: value, amountMsat };
    step.value = 'confirm';
  };
  const friendlyError = (error: unknown): string => {
    const message = error instanceof Error ? error.message : 'Something went wrong.';
    return message.startsWith('No mint holds enough')
      ? 'Not enough spendable balance to cover that payment.'
      : message;
  };
  const pay = async (): Promise<void> => {
    const payment = pendingPayment.value;
    if (!payment) return;
    step.value = 'working';
    stage.value = 'Preparing the exact amount and sending the payment…';
    let ownerFence: WalletOwnerFence | undefined;
    try {
      ownerFence = wallet.captureOwnerFence();
      const commitContext = { ownerFence, warn: warnCommitted };
      const paid = await payWithBearers(
        wallet.bearers,
        payment.input,
        payment.kind === 'address'
          ? { amountMsat: payment.amountMsat, assertOwner: ownerFence }
          : { assertOwner: ownerFence },
      );
      stage.value = 'Confirming the result…';
      const committed = await commitCarve(wallet, paid.carve, commitContext);
      if (paid.rescuedNote) {
        await addCommittedBearers(wallet, [paid.rescuedNote], commitContext);
      }
      const sats = formatSats(msatToSats(paid.amountMsat));
      if (paid.outcome === 'settled') {
        await wallet.markSpent(committed.id, ownerFence);
        await activity.log('melt', `Paid ${sats} sats over Lightning.`, (error) =>
          warnCommitted(error.message),
        );
        toast('positive', `Paid ${sats} sats.`);
        emit('sent');
      } else if (paid.outcome === 'failed-funds-returned') {
        await activity.log(
          'transfer',
          `A ${sats} sat payment failed - funds are back in your wallet.`,
          (error) => warnCommitted(error.message),
        );
        toast('warning', 'Payment failed - funds are back in your wallet.');
      } else if (paid.outcome === 'unknown-still-pending') {
        await wallet.markSpent(committed.id, ownerFence);
        await activity.log(
          'melt',
          `Payment of ${sats} sats is still in flight - the note is locked.`,
          (error) => warnCommitted(error.message),
        );
        emit('sent');
      } else {
        await wallet.markSpent(committed.id, ownerFence);
        await activity.log('spent', `A ${sats} sat note was already spent at the mint.`, (error) =>
          warnCommitted(error.message),
        );
      }
      result.value = { outcome: paid.outcome, amountMsat: paid.amountMsat };
      step.value = 'result';
    } catch (error) {
      if (error instanceof UncertainOutcomeError) {
        if (!ownerFence) throw error;
        await addCommittedBearers(wallet, error.possibleOutputs, {
          ownerFence,
          warn: warnCommitted,
        });
        await activity.log(
          'transfer',
          'A payment preparation could not be confirmed - possible notes stored unverified.',
          (activityError) => warnCommitted(activityError.message),
        );
        inlineError.value =
          "Couldn't confirm with the mint. Your original notes are untouched, and the possible new notes are stored unverified - refresh your wallet later to reconcile.";
        toast('warning', 'Payment preparation uncertain - see the notice in the dialog.');
      } else {
        inlineError.value = friendlyError(error);
        toast('negative', inlineError.value);
      }
      step.value = 'input';
    }
  };
  const closeResult = (): void => {
    show.value = false;
  };
  return {
    addressAmountSats,
    closeResult,
    formatSats,
    inlineError,
    input,
    msatToSats,
    onScan,
    onScanError,
    paste,
    pay,
    pendingPayment,
    proceed,
    result,
    resultAmountSats,
    show,
    showScanner,
    stage,
    step,
    targetKind,
    truncatedInput,
  };
};
