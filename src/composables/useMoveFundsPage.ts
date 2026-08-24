import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { describeMintFee, noteK1, serverOf } from 'lnurlcash-kit';
import type { MintFee } from 'lnurlcash-kit';

import { transferBetweenMints } from '@/lnurlcash/ops';
import type { TransferOutcome } from '@/lnurlcash/ops';
import { maxNetForBalance, quoteMintFee } from '@/lnurlcash/fees';
import type { NewBearer } from '@/lnurlcash/types';
import { floorMsatToSat, msatToSats, satsToMsat, MSAT_PER_SAT } from '@/lnurlcash/units';
import { useWalletStore } from '@/stores/wallet';
import { useMintsStore } from '@/stores/mints';
import { useActivityStore } from '@/stores/activity';
import { addCommittedBearers, commitCarve } from './walletCarveCommit';

type Option = Readonly<{ label: string; value: string }>;
type TransferResult = Readonly<{
  outcome: TransferOutcome;
  requestedSats: number;
  feeSats: number;
  sourceServer: string;
  targetServer: string;
  claimNoteValueSats?: number;
}>;

export const useMoveFundsPage = () => {
  const router = useRouter();
  const $q = useQuasar();
  const wallet = useWalletStore();
  const mints = useMintsStore();
  const activity = useActivityStore();
  const toast = (type: 'positive' | 'negative' | 'warning' | 'info', message: string): void => {
    if (typeof $q.notify === 'function') {
      $q.notify({ type, message, position: 'top', timeout: 3000 });
    }
  };
  const warnCommitted = (message: string): void => toast('warning', message);
  watch(
    () => wallet.state,
    (state) => {
      if (state !== 'unlocked') void router.replace('/');
    },
    { immediate: true },
  );
  const CUSTOM_TARGET = '__custom__';
  const displaySats = (msat: number): number => floorMsatToSat(msat) / MSAT_PER_SAT;
  const spendableByServerMsat = computed(() => {
    const byServer = new Map<string, number>();
    for (const bearer of wallet.bearers) {
      if (bearer.spent || bearer.callback === '' || bearer.deviceId || !noteK1(bearer.url))
        continue;
      const server = serverOf(bearer.url);
      byServer.set(server, (byServer.get(server) ?? 0) + bearer.amount);
    }
    return byServer;
  });
  const sourceOptions = computed<Option[]>(() =>
    [...spendableByServerMsat.value.entries()].map(([server, msat]) => ({
      label: `${server} - ${displaySats(msat).toLocaleString()} sats available`,
      value: server,
    })),
  );
  const step = ref<'form' | 'confirm' | 'working' | 'result'>('form');
  const sourceServer = ref('');
  const targetChoice = ref('');
  const customTarget = ref('');
  const amountSats = ref<number | null>(null);
  const inlineError = ref('');
  const stage = ref('');
  const result = ref<TransferResult | null>(null);
  const targetOptions = computed<Option[]>(() => {
    const options: Option[] = [];
    for (const mint of mints.mints) {
      if (mint.server === sourceServer.value) continue;
      const address = mint.username ? `${mint.username}@${mint.server}` : `@${mint.server}`;
      options.push({
        label: mint.nodeAlias ? `${address} (${mint.nodeAlias})` : address,
        value: address,
      });
    }
    options.push({ label: 'Another mint…', value: CUSTOM_TARGET });
    return options;
  });
  const targetInput = computed(() =>
    targetChoice.value === CUSTOM_TARGET ? customTarget.value.trim() : targetChoice.value,
  );
  const formFilled = computed(
    () =>
      sourceServer.value !== '' &&
      targetInput.value !== '' &&
      Number.isInteger(amountSats.value) &&
      (amountSats.value ?? 0) >= 1,
  );
  const targetFee = ref<MintFee | null>(null);
  let quoteTimer: ReturnType<typeof setTimeout> | null = null;
  watch(targetInput, (input) => {
    targetFee.value = null;
    if (quoteTimer) clearTimeout(quoteTimer);
    if (input === '') return;
    quoteTimer = setTimeout(() => {
      void quoteMintFee(input).then((fee) => {
        if (targetInput.value === input) targetFee.value = fee;
      });
    }, 400);
  });
  const targetFeeText = computed(() =>
    targetFee.value
      ? `This mint charges a receive fee (${describeMintFee(targetFee.value)}) - Max already accounts for it.`
      : '',
  );
  const setMax = (): void => {
    const msat = spendableByServerMsat.value.get(sourceServer.value) ?? 0;
    amountSats.value = displaySats(maxNetForBalance(msat, targetFee.value));
  };
  const proceed = (): void => {
    inlineError.value = '';
    const sats = amountSats.value;
    if (!sats || !Number.isInteger(sats) || sats < 1) {
      inlineError.value = 'Enter how many sats to move.';
      return;
    }
    const sourceMsat = spendableByServerMsat.value.get(sourceServer.value) ?? 0;
    if (satsToMsat(sats) > sourceMsat) {
      inlineError.value = `That's more than the ${displaySats(sourceMsat).toLocaleString()} sats spendable at ${sourceServer.value}.`;
      return;
    }
    step.value = 'confirm';
  };
  const move = async (): Promise<void> => {
    const sats = amountSats.value;
    if (!sats) return;
    step.value = 'working';
    stage.value = 'Asking the target mint for an invoice…';
    try {
      const ownerFence = wallet.captureOwnerFence();
      const commitContext = { ownerFence, warn: warnCommitted };
      const transfer = await transferBetweenMints(
        wallet.bearers,
        satsToMsat(sats),
        targetInput.value,
        { assertOwner: ownerFence },
      );
      stage.value = 'Confirming the result…';
      const carved = await commitCarve(wallet, transfer.carve, commitContext);
      if (transfer.rescuedNote) {
        await addCommittedBearers(wallet, [transfer.rescuedNote], commitContext);
      }
      const feeSats = msatToSats(transfer.quote.targetMintFeeMsat);
      if (transfer.outcome === 'settled') {
        await wallet.markSpent(carved.id, ownerFence);
        const claimed = transfer.mintedAtTarget;
        if (claimed) {
          const notes: NewBearer[] = claimed.possibleCopy
            ? [claimed.note, claimed.possibleCopy]
            : [claimed.note];
          await addCommittedBearers(wallet, notes, commitContext);
        }
        await activity.log(
          'transfer',
          `Moved ${sats.toLocaleString()} sats from ${transfer.sourceServer} to ${transfer.targetServer}.`,
          (error) => warnCommitted(error.message),
        );
        toast('positive', `Moved ${sats.toLocaleString()} sats.`);
      } else if (transfer.outcome === 'failed-funds-returned') {
        await activity.log(
          'transfer',
          `A ${sats.toLocaleString()} sat move to ${transfer.targetServer} failed - funds are back in your wallet.`,
          (error) => warnCommitted(error.message),
        );
      } else if (transfer.outcome === 'unknown-still-pending') {
        await wallet.markSpent(carved.id, ownerFence);
        await activity.log(
          'transfer',
          `A move of ${sats.toLocaleString()} sats to ${transfer.targetServer} is still in flight - the note is locked.`,
          (error) => warnCommitted(error.message),
        );
      } else if (transfer.outcome === 'settled-claim-failed') {
        await wallet.markSpent(carved.id, ownerFence);
        if (transfer.claimMaterial?.note) {
          await addCommittedBearers(wallet, [transfer.claimMaterial.note], commitContext);
        }
        await activity.log(
          'transfer',
          `${sats.toLocaleString()} sats arrived at ${transfer.targetServer} but claiming the note failed - it is saved unverified.`,
          (error) => warnCommitted(error.message),
        );
      } else {
        await wallet.markSpent(carved.id, ownerFence);
        await activity.log(
          'spent',
          `A ${sats.toLocaleString()} sat note was already spent at ${transfer.sourceServer}.`,
          (error) => warnCommitted(error.message),
        );
      }
      const claimNote = transfer.claimMaterial?.note ?? null;
      result.value = {
        outcome: transfer.outcome,
        requestedSats: sats,
        feeSats,
        sourceServer: transfer.sourceServer,
        targetServer: transfer.targetServer,
        ...(claimNote ? { claimNoteValueSats: displaySats(claimNote.amount) } : {}),
      };
      step.value = 'result';
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Something went wrong.';
      inlineError.value = message.startsWith('No mint holds enough')
        ? 'Not enough spendable balance at the source mint to cover that move.'
        : message;
      toast('negative', inlineError.value);
      step.value = 'form';
    }
  };
  return {
    CUSTOM_TARGET,
    amountSats,
    customTarget,
    formFilled,
    inlineError,
    move,
    proceed,
    result,
    router,
    setMax,
    sourceOptions,
    sourceServer,
    stage,
    step,
    targetChoice,
    targetFeeText,
    targetInput,
    targetOptions,
  };
};
