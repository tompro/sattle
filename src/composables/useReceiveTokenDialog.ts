import { computed, ref, watch } from 'vue';
import { Notify } from 'quasar';
import {
  NoteSpentError,
  NoteUnknownError,
  PendingNoteError,
  isValidNoteInput,
} from 'lnurlcash-kit';

import { receiveBearer } from '@/lnurlcash/ops';
import type { NewBearer } from '@/lnurlcash/types';
import { floorMsatToSat, MSAT_PER_SAT } from '@/lnurlcash/units';
import { TrustedMintPostCommitError, useWalletStore } from '@/stores/wallet';
import { useMintsStore } from '@/stores/mints';
import { useActivityStore } from '@/stores/activity';
import { useMintTrustPrompt } from './useMintTrustPrompt';

type ReceiveTokenProps = Readonly<{ modelValue: boolean; initialInput?: string }>;
type ReceiveTokenEmit = {
  (event: 'received'): void;
};
type ReceiveErrorKind = 'spent' | 'unknown' | 'pending' | 'duplicate' | 'invalid' | 'generic' | '';

const ERROR_TEXT: Readonly<Record<Exclude<ReceiveErrorKind, ''>, string>> = {
  spent: 'This note has already been spent.',
  unknown: "The mint doesn't know this note.",
  pending: 'This note is locked mid-payment — try again shortly.',
  duplicate: 'This note is already in your wallet.',
  invalid: 'Not a valid bearer note.',
  generic: '',
};
const ERROR_ICON: Readonly<Record<Exclude<ReceiveErrorKind, ''>, string>> = {
  spent: 'money_off',
  unknown: 'help_outline',
  pending: 'hourglass_top',
  duplicate: 'content_copy',
  invalid: 'error_outline',
  generic: 'error_outline',
};

export const useReceiveTokenDialog = (props: ReceiveTokenProps, emit: ReceiveTokenEmit) => {
  const wallet = useWalletStore();
  const mints = useMintsStore();
  const activity = useActivityStore();
  const displaySats = (msat: number): number => floorMsatToSat(msat) / MSAT_PER_SAT;
  const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : 'Something went wrong.';
  const step = ref<'input' | 'success'>('input');
  const input = ref('');
  const scanning = ref(false);
  const busy = ref(false);
  const errorKind = ref<ReceiveErrorKind>('');
  const errorMessageText = ref('');
  const receivedSats = ref(0);
  const receivedServer = ref('');
  const unverifiedNote = ref(false);
  const rotationWarning = ref('');
  const trustPrompt = useMintTrustPrompt();
  const errorText = computed(() =>
    errorKind.value === 'generic'
      ? errorMessageText.value
      : errorKind.value === ''
        ? ''
        : ERROR_TEXT[errorKind.value],
  );
  const errorIcon = computed(() =>
    errorKind.value === '' ? 'error_outline' : ERROR_ICON[errorKind.value],
  );
  const inputValid = computed(() => isValidNoteInput(input.value.trim()));
  const clearError = (): void => {
    errorKind.value = '';
    errorMessageText.value = '';
  };
  const classifyError = (error: unknown): void => {
    let kind: Exclude<ReceiveErrorKind, ''>;
    if (error instanceof NoteSpentError) kind = 'spent';
    else if (error instanceof NoteUnknownError) kind = 'unknown';
    else if (error instanceof PendingNoteError) kind = 'pending';
    else if (error instanceof Error && error.message.includes('already in your wallet')) {
      kind = 'duplicate';
    } else if (error instanceof Error && error.message.includes('Not an LNURLcash bearer note')) {
      kind = 'invalid';
    } else {
      kind = 'generic';
      errorMessageText.value = errorMessage(error);
    }
    errorKind.value = kind;
    Notify.create({
      type: 'negative',
      message: kind === 'generic' ? errorMessageText.value : ERROR_TEXT[kind],
    });
  };
  const receive = async (): Promise<void> => {
    const value = input.value.trim();
    if (busy.value || value === '') return;
    busy.value = true;
    clearError();
    try {
      const ownerFence = wallet.captureOwnerFence();
      const claimed = await receiveBearer(value, wallet.bearers, {
        assertOwner: ownerFence,
      });
      const note = claimed.note;
      const server = new URL(note.url).host;
      const wasTrusted = mints.isTrusted(server);
      const notes: NewBearer[] = claimed.possibleCopy ? [note, claimed.possibleCopy] : [note];
      let trustWarning = '';
      try {
        await wallet.addBearers(notes, ownerFence);
      } catch (error) {
        if (!(error instanceof TrustedMintPostCommitError)) throw error;
        trustWarning = error.message;
      }
      receivedSats.value = displaySats(note.amount);
      receivedServer.value = server;
      unverifiedNote.value = !note.verified;
      rotationWarning.value = claimed.rotationError ?? '';
      await activity.log(
        'receive',
        `Received ${receivedSats.value.toLocaleString()} sats from ${server}.`,
        (error) => Notify.create({ type: 'warning', message: error.message }),
      );
      Notify.create({
        type: 'positive',
        message: `Received ${receivedSats.value.toLocaleString()} sats.`,
      });
      if (trustWarning) Notify.create({ type: 'warning', message: trustWarning });
      emit('received');
      scanning.value = false;
      step.value = 'success';
      if (!wasTrusted && note.mintPubkey) {
        trustPrompt.openTrust(server, note.mintPubkey);
      }
    } catch (error) {
      classifyError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      busy.value = false;
    }
  };
  const onScan = (text: string): void => {
    input.value = text;
    scanning.value = false;
    void receive();
  };
  const onScanError = (message: string): void => {
    scanning.value = false;
    Notify.create({ type: 'negative', message });
  };
  watch(
    () => props.modelValue,
    (open) => {
      if (!open) return;
      step.value = 'input';
      input.value = props.initialInput ?? '';
      scanning.value = false;
      busy.value = false;
      clearError();
      unverifiedNote.value = false;
      rotationWarning.value = '';
    },
  );
  return {
    busy,
    errorIcon,
    errorKind,
    errorText,
    input,
    inputValid,
    onScan,
    onScanError,
    receive,
    receivedSats,
    receivedServer,
    rotationWarning,
    scanning,
    showTrust: trustPrompt.showTrust,
    skipTrust: trustPrompt.skipTrust,
    step,
    trustMint: trustPrompt.trustMint,
    trustServer: trustPrompt.trustServer,
    unverifiedNote,
  };
};
