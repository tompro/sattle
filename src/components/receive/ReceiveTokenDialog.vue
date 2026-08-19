<template>
  <q-dialog
    :model-value="modelValue"
    position="bottom"
    transition-show="slide-up"
    transition-hide="slide-down"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <q-card class="sattle-card receive-dialog q-pb-md">
      <q-card-section class="row items-center q-pb-sm">
        <div class="col text-h6">Receive bearer note</div>
        <q-btn v-close-popup flat round dense icon="close" color="primary" />
      </q-card-section>

      <!-- input -->
      <q-card-section v-if="step === 'input'" class="q-pt-sm">
        <qr-scanner
          v-if="scanning"
          class="q-mb-md"
          @decode="onScan"
          @error="onScanError"
        />

        <q-input
          v-model="input"
          type="textarea"
          rows="3"
          dark
          outlined
          color="primary"
          label="Bearer note"
          placeholder="lnurlw://… or lnurl1…"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :error="input.trim() !== '' && !inputValid"
          error-message="Not a valid bearer note."
          class="q-mb-sm"
        />

        <q-banner v-if="errorKind !== ''" class="sattle-card text-negative q-mb-sm" rounded>
          <template #avatar>
            <q-icon :name="errorIcon" color="negative" />
          </template>
          {{ errorText }}
        </q-banner>

        <div class="row q-gutter-sm q-mt-sm">
          <q-btn
            outline
            no-caps
            color="primary"
            :icon="scanning ? 'keyboard' : 'qr_code_scanner'"
            :label="scanning ? 'Paste instead' : 'Scan'"
            @click="scanning = !scanning"
          />
          <q-btn
            unelevated
            no-caps
            color="primary"
            text-color="dark"
            label="Receive"
            class="col"
            :loading="busy"
            :disable="input.trim() === '' || !inputValid"
            @click="receive"
          />
        </div>
      </q-card-section>

      <!-- success -->
      <q-card-section v-else class="q-pt-sm">
        <div class="column items-center text-center q-gutter-sm q-mb-md">
          <q-icon name="check_circle" color="positive" size="56px" />
          <div class="text-h5 text-weight-bold">
            Received {{ receivedSats.toLocaleString() }} sats
          </div>
          <div class="text-body2 text-grey-5">from {{ receivedServer }}</div>
        </div>

        <q-banner v-if="unverifiedNote" class="sattle-card text-info q-mb-md" rounded>
          <template #avatar>
            <q-icon name="info" color="info" />
          </template>
          The mint could not be reached, so the note is stored unconfirmed at the
          sender's declared amount. Refresh it later to confirm.
        </q-banner>

        <q-banner v-if="rotationWarning" class="sattle-card text-warning q-mb-md" rounded>
          <template #avatar>
            <q-icon name="warning" color="warning" />
          </template>
          The note is in your wallet, but it could not be fully secured yet — the
          sender may still hold a copy. You can secure it later.
        </q-banner>

        <q-btn
          v-close-popup
          unelevated
          color="primary"
          text-color="dark"
          label="Done"
          class="full-width"
        />
      </q-card-section>
    </q-card>

    <!-- first-contact mint trust prompt -->
    <q-dialog v-model="showTrust" persistent>
      <q-card class="sattle-card trust-card q-pa-lg">
        <div class="text-h6 q-mb-sm">New mint</div>
        <div class="text-body2 q-mb-md">
          This note came from a mint you have not used before:
          <strong>{{ trustServer }}</strong>
        </div>
        <div class="text-caption text-grey-5 q-mb-md">
          Trusting saves the mint so it is offered next time. You can manage trusted
          mints in Settings.
        </div>
        <div class="row q-gutter-sm justify-end">
          <q-btn flat no-caps color="grey-5" label="Just this once" @click="skipTrust" />
          <q-btn
            unelevated
            no-caps
            color="primary"
            text-color="dark"
            label="Trust this mint"
            @click="trustMint"
          />
        </div>
      </q-card>
    </q-dialog>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Notify } from 'quasar';
import {
  NoteSpentError,
  NoteUnknownError,
  PendingNoteError,
  isValidNoteInput,
} from 'lnurlcash-kit';

import QrScanner from '../QrScanner.vue';
import { receiveBearer } from '@/lnurlcash/ops';
import type { NewBearer } from '@/lnurlcash/types';
import { floorMsatToSat, MSAT_PER_SAT } from '@/lnurlcash/units';
import { useWalletStore } from '@/stores/wallet';
import { useMintsStore } from '@/stores/mints';
import { useActivityStore } from '@/stores/activity';

const props = defineProps<{ modelValue: boolean; initialInput?: string }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  received: [];
}>();

const wallet = useWalletStore();
const mints = useMintsStore();
const activity = useActivityStore();

// whole-sat display for received amounts (msat remainder rounded down, per
// units.ts's floorMsatToSat)
const displaySats = (msat: number): number => floorMsatToSat(msat) / MSAT_PER_SAT;

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : 'Something went wrong.';

// distinct, jargon-free error states for the definitive service answers
type ReceiveErrorKind =
  | 'spent'
  | 'unknown'
  | 'pending'
  | 'duplicate'
  | 'invalid'
  | 'generic'
  | '';

const ERROR_TEXT: Record<Exclude<ReceiveErrorKind, ''>, string> = {
  spent: 'This note has already been spent.',
  unknown: "The mint doesn't know this note.",
  pending: 'This note is locked mid-payment — try again shortly.',
  duplicate: 'This note is already in your wallet.',
  invalid: 'Not a valid bearer note.',
  generic: '',
};

const ERROR_ICON: Record<Exclude<ReceiveErrorKind, ''>, string> = {
  spent: 'money_off',
  unknown: 'help_outline',
  pending: 'hourglass_top',
  duplicate: 'content_copy',
  invalid: 'error_outline',
  generic: 'error_outline',
};

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

type Step = 'input' | 'success';
const step = ref<Step>('input');

const input = ref('');
const scanning = ref(false);
const busy = ref(false);
const errorKind = ref<ReceiveErrorKind>('');
const errorMessageText = ref('');

const inputValid = computed(() => isValidNoteInput(input.value.trim()));

const clearError = () => {
  errorKind.value = '';
  errorMessageText.value = '';
};

const classifyError = (err: unknown): void => {
  let kind: Exclude<ReceiveErrorKind, ''>;
  if (err instanceof NoteSpentError) {
    kind = 'spent';
  } else if (err instanceof NoteUnknownError) {
    kind = 'unknown';
  } else if (err instanceof PendingNoteError) {
    kind = 'pending';
  } else if (err instanceof Error && err.message.includes('already in your wallet')) {
    kind = 'duplicate';
  } else if (err instanceof Error && err.message.includes('Not an LNURLcash bearer note')) {
    kind = 'invalid';
  } else {
    kind = 'generic';
    errorMessageText.value = errMsg(err);
  }
  errorKind.value = kind;
  Notify.create({
    type: 'negative',
    message: kind === 'generic' ? errorMessageText.value : ERROR_TEXT[kind],
  });
};

// re-entrancy guard: a scanner double-fire or Enter+click landing together
// must not run two receives for the same note - both would pass the
// duplicate check before either addBearers landed
const receive = async () => {
  const value = input.value.trim();
  if (busy.value || value === '') return;
  busy.value = true;
  clearError();
  try {
    const claimed = await receiveBearer(value, wallet.bearers);
    const note = claimed.note;
    const server = new URL(note.url).host;
    const wasTrusted = mints.isTrusted(server);
    const notes: NewBearer[] = claimed.possibleCopy
      ? [note, claimed.possibleCopy]
      : [note];
    await wallet.addBearers(notes);
    receivedSats.value = displaySats(note.amount);
    receivedServer.value = server;
    unverifiedNote.value = !note.verified;
    rotationWarning.value = claimed.rotationError ?? '';
    activity.log(
      'receive',
      `Received ${receivedSats.value.toLocaleString()} sats from ${server}.`,
    );
    Notify.create({
      type: 'positive',
      message: `Received ${receivedSats.value.toLocaleString()} sats.`,
    });
    emit('received');
    scanning.value = false;
    step.value = 'success';
    if (!wasTrusted && note.mintPubkey) {
      trustServer.value = server;
      trustPubkey.value = note.mintPubkey;
      showTrust.value = true;
    }
  } catch (err) {
    classifyError(err);
  } finally {
    busy.value = false;
  }
};

const onScan = (text: string) => {
  input.value = text;
  scanning.value = false;
  void receive();
};

const onScanError = (message: string) => {
  scanning.value = false;
  Notify.create({ type: 'negative', message });
};

// ---- success ----
const receivedSats = ref(0);
const receivedServer = ref('');
const unverifiedNote = ref(false);
const rotationWarning = ref('');

// ---- trust prompt ----
const showTrust = ref(false);
const trustServer = ref('');
const trustPubkey = ref('');

const trustMint = () => {
  try {
    mints.trust(trustServer.value, trustPubkey.value);
    Notify.create({ type: 'positive', message: 'Mint trusted.' });
  } catch (err) {
    Notify.create({ type: 'negative', message: errMsg(err) });
  } finally {
    showTrust.value = false;
  }
};

const skipTrust = () => {
  showTrust.value = false;
  Notify.create({
    type: 'warning',
    message: 'Note added, but this mint is not in your trusted list yet — you can review it in Settings.',
  });
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
</script>

<style lang="scss" scoped>
.receive-dialog {
  width: 100%;
  max-width: 480px;
  border-radius: 16px 16px 0 0;
}

.trust-card {
  width: 100%;
  max-width: 400px;
}
</style>
