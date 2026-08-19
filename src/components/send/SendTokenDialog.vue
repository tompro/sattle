<script setup lang="ts">
// Send a bearer note: pick an amount, carve a fresh note worth exactly that
// much out of the wallet (the ops engine does the mint calls), then hand it
// over as a QR / link. The QR hides behind a tap-to-reveal cover - anyone
// who sees it can take the sats.
//
// Fund-safety order when applying the carve: the replacement notes are
// added to the wallet BEFORE the consumed ones are marked spent, so a crash
// mid-way strands a duplicate, never a secret.
import { computed, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import { toBech32Lnurl } from 'lnurlcash-kit';

import QrCode from '@/components/QrCode.vue';
import { ensureExactAmount, UncertainOutcomeError } from '@/lnurlcash/ops';
import type { CarveResult } from '@/lnurlcash/ops';
import type { Bearer, NewBearer } from '@/lnurlcash/types';
import { msatToSats, satsToMsat } from '@/lnurlcash/units';
import { useWalletStore } from '@/stores/wallet';
import { useActivityStore } from '@/stores/activity';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  sent: [];
}>();

const $q = useQuasar();
const wallet = useWalletStore();
const activity = useActivityStore();

const toast = (type: 'positive' | 'negative' | 'warning' | 'info', message: string): void => {
  // guarded: the Notify plugin registration lives in quasar.config, outside
  // this component's control - a missing registration must not break a flow
  if (typeof $q.notify === 'function') {
    $q.notify({ type, message, position: 'top', timeout: 3000 });
  }
};

const show = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
});

type Step = 'amount' | 'ready';
const step = ref<Step>('amount');
const amountSats = ref('');
const preparing = ref(false);
const removing = ref(false);
const errorMessage = ref<string | null>(null);
const prepared = ref<Bearer | null>(null);
const revealed = ref(false);

const formatSats = (sats: number): string =>
  sats.toLocaleString(undefined, { maximumFractionDigits: 3 });

const parsedAmount = computed<number | null>(() => {
  const n = Number(amountSats.value);
  return Number.isInteger(n) && n > 0 ? n : null;
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

const canShare =
  typeof navigator !== 'undefined' && typeof navigator.share === 'function';

const reset = () => {
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

// Applies a carve to the wallet in the only safe order: add the fresh
// note(s) first, mark the consumed inputs spent after. Returns the wallet
// id of the carved note (for the exact-match path the note already exists
// in the wallet, so it is found by url instead of re-added).
const applyCarve = async (carve: CarveResult): Promise<Bearer> => {
  const existing = wallet.bearers.find((b) => b.url === carve.note.url);
  const toAdd: NewBearer[] = [];
  if (!existing) toAdd.push(carve.note);
  if (carve.change) toAdd.push(carve.change);
  const added = toAdd.length > 0 ? await wallet.addBearers(toAdd) : [];
  for (const consumed of carve.consumed) {
    await wallet.markSpent(consumed.id);
  }
  return existing ?? added[0];
};

const prepare = async () => {
  const sats = parsedAmount.value;
  if (sats === null || amountError.value !== null) return;
  preparing.value = true;
  errorMessage.value = null;
  try {
    const carve = await ensureExactAmount(wallet.bearers, satsToMsat(sats));
    const note = await applyCarve(carve);
    if (carve.change) {
      activity.log('split', `Prepared a ${formatSats(sats)} sat note to hand over.`);
    } else if (carve.consumed.length > 1) {
      activity.log('combine', `Combined notes into a ${formatSats(sats)} sat note.`);
    }
    prepared.value = note;
    revealed.value = false;
    step.value = 'ready';
  } catch (err) {
    if (err instanceof UncertainOutcomeError) {
      // the mutation may have landed - the possible outputs carry fresh
      // secrets and must be tracked alongside the (kept) originals
      await wallet.addBearers(err.possibleOutputs);
      activity.log(
        'transfer',
        'A note preparation could not be confirmed - possible notes stored unverified.',
      );
      errorMessage.value =
        "Couldn't confirm with the mint. Your original notes are untouched, and the possible new notes are stored unverified - refresh your wallet later to reconcile.";
      toast('warning', 'Preparation uncertain - see the notice in the dialog.');
      return;
    }
    const message = err instanceof Error ? err.message : 'Something went wrong.';
    errorMessage.value = message.startsWith('No mint holds enough')
      ? 'Not enough spendable balance to cover that amount.'
      : message;
    toast('negative', errorMessage.value);
  } finally {
    preparing.value = false;
  }
};

const copyNote = async () => {
  try {
    await navigator.clipboard.writeText(noteDisplayValue.value);
    toast('positive', 'Note copied to clipboard.');
  } catch {
    toast('negative', "Couldn't copy - reveal the note and copy it manually.");
  }
};

const shareNote = async () => {
  try {
    await navigator.share({ title: 'sattle bearer note', text: noteDisplayValue.value });
  } catch (err) {
    // the user dismissing the share sheet is not an error
    if (err instanceof DOMException && err.name === 'AbortError') return;
    await copyNote();
  }
};

const finishRemove = async () => {
  const note = prepared.value;
  if (!note) return;
  removing.value = true;
  try {
    await wallet.markSpent(note.id);
    activity.log('spent', `Handed over a ${formatSats(msatToSats(note.amount))} sat note.`);
    toast('positive', 'Removed from your balance.');
    emit('sent');
    show.value = false;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Something went wrong.';
    toast('negative', message);
  } finally {
    removing.value = false;
  }
};

const finishKeep = () => {
  toast('info', 'Note kept in your wallet.');
  show.value = false;
};
</script>

<template>
  <q-dialog
    v-model="show"
    position="bottom"
    transition-show="slide-up"
    transition-hide="slide-down"
    :persistent="preparing"
  >
    <q-card class="sattle-card drawer-card full-width">
      <q-card-section class="row items-center q-pb-sm">
        <q-btn
          v-close-popup
          flat
          round
          dense
          icon="close"
          color="primary"
          aria-label="Close"
          :disable="preparing"
        />
        <div class="col text-center">
          <span class="text-h6 text-primary">Send a note</span>
        </div>
        <div style="width: 40px" />
      </q-card-section>

      <!-- step 1: amount -->
      <q-card-section v-if="step === 'amount'" class="q-pa-md q-pt-sm">
        <div class="text-caption text-grey-5 q-mb-md">
          Spendable balance: {{ formatSats(wallet.balanceSats) }} sats
        </div>
        <q-input
          v-model="amountSats"
          type="number"
          min="1"
          step="1"
          label="Amount (sats)"
          outlined
          color="primary"
          :error="amountError !== null"
          :error-message="amountError ?? undefined"
          :disable="preparing"
        />
        <q-banner v-if="errorMessage" dense class="bg-negative text-white q-mt-md rounded-borders">
          {{ errorMessage }}
        </q-banner>
        <div class="row justify-end q-gutter-sm q-mt-lg">
          <q-btn v-close-popup flat label="Cancel" color="grey-5" :disable="preparing" />
          <q-btn
            unelevated
            color="primary"
            text-color="dark"
            label="Prepare note"
            :loading="preparing"
            :disable="!canPrepare"
            @click="prepare"
          />
        </div>
      </q-card-section>

      <!-- step 2: hand over -->
      <q-card-section v-else class="q-pa-md q-pt-sm column items-center">
        <div class="text-h6 text-primary q-mb-sm">
          {{ prepared ? formatSats(msatToSats(prepared.amount)) : '' }} sats
        </div>

        <div
          class="qr-box"
          role="button"
          tabindex="0"
          @click="revealed = true"
          @keydown.enter.prevent="revealed = true"
        >
          <QrCode v-if="revealed" :value="noteDisplayValue" :size="220" />
          <div v-else class="qr-cover column items-center justify-center">
            <q-icon name="visibility" size="32px" color="primary" />
            <div class="text-body2 text-primary q-mt-sm">Tap to reveal</div>
            <div class="text-caption text-grey-5 q-mt-xs text-center q-px-md">
              Anyone who sees this code can take the sats
            </div>
          </div>
        </div>

        <div class="row q-gutter-sm q-mt-md">
          <q-btn outline color="primary" icon="content_copy" label="Copy" @click="copyNote" />
          <q-btn
            v-if="canShare"
            outline
            color="primary"
            icon="share"
            label="Share"
            @click="shareNote"
          />
        </div>

        <div class="text-caption text-grey-5 text-center q-mt-md">
          Whoever opens this link gets the sats. Your copy stays in the wallet until you remove it.
        </div>

        <div class="column q-gutter-sm q-mt-lg full-width">
          <q-btn
            unelevated
            color="primary"
            text-color="dark"
            label="Done — remove from my balance"
            :loading="removing"
            @click="finishRemove"
          />
          <q-btn flat color="grey-5" label="Keep in wallet" :disable="removing" @click="finishKeep" />
        </div>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>

<style lang="scss" scoped>
.drawer-card {
  border-top-left-radius: 20px;
  border-top-right-radius: 20px;
  padding-bottom: 16px;
}

.qr-box {
  cursor: pointer;
}

.qr-cover {
  width: 232px; /* 220 QR + 6px frame padding, matching QrCode's frame */
  height: 232px;
  border-radius: 8px;
  border: 1px dashed rgba(85, 255, 204, 0.4);
  background: rgba(0, 34, 34, 0.6);
}
</style>
