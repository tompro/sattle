<script setup lang="ts">
// Pay over Lightning: paste or scan a bolt11 invoice or a Lightning
// Address, confirm the amount, and the ops engine carves an exact-amount
// note out of the wallet and pays with it. The four possible outcomes are
// surfaced as distinct result screens - including the silent-failure case
// where the funds come back.
//
// Fund-safety order when applying the carve: fresh notes are added to the
// wallet BEFORE consumed inputs are marked spent.
import { computed, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import { decodeBolt11AmountMsat, isBolt11Invoice, resolveLnurlInput } from 'lnurlcash-kit';

import QrScanner from '@/components/QrScanner.vue';
import { readClipboard } from '@/capabilities/clipboard';
import { payWithBearers, UncertainOutcomeError } from '@/lnurlcash/ops';
import type { CarveResult, PayOutcome } from '@/lnurlcash/ops';
import type { NewBearer } from '@/lnurlcash/types';
import { msatToSats, satsToMsat } from '@/lnurlcash/units';
import { useWalletStore } from '@/stores/wallet';
import { useActivityStore } from '@/stores/activity';

const props = defineProps<{ modelValue: boolean; initialInput?: string }>();
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

type Step = 'input' | 'confirm' | 'working' | 'result';
type TargetKind = 'invoice' | 'address';

type PendingPayment = {
  kind: TargetKind;
  input: string;
  amountMsat: number;
};

type Result = {
  outcome: PayOutcome;
  amountMsat: number;
};

const step = ref<Step>('input');
const input = ref('');
const addressAmountSats = ref('');
const showScanner = ref(false);
const inlineError = ref<string | null>(null);
const stage = ref('');
const pendingPayment = ref<PendingPayment | null>(null);
const result = ref<Result | null>(null);

const formatSats = (sats: number): string =>
  sats.toLocaleString(undefined, { maximumFractionDigits: 3 });

const classify = (value: string): TargetKind | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isBolt11Invoice(trimmed)) return 'invoice';
  // resolveLnurlInput also accepts Lightning Addresses, bech32 LNURLs and
  // lightning= deep links - anything it resolves can be paid
  if (resolveLnurlInput(trimmed) !== null) return 'address';
  return null;
};

const targetKind = computed<TargetKind | null>(() => classify(input.value));

const truncatedInput = computed(() => {
  const p = pendingPayment.value;
  if (!p) return '';
  if (p.kind === 'address') return p.input;
  return p.input.length > 30 ? `${p.input.slice(0, 18)}…${p.input.slice(-8)}` : p.input;
});

const resultAmountSats = computed(() =>
  result.value ? formatSats(msatToSats(result.value.amountMsat)) : '',
);

const reset = () => {
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

const onScan = (text: string) => {
  input.value = text.replace(/^lightning:/i, '').trim();
  showScanner.value = false;
};

const onScanError = (message: string) => {
  showScanner.value = false;
  toast('negative', message);
};

const paste = async () => {
  try {
    const text = await readClipboard();
    if (text) input.value = text.trim();
  } catch {
    toast('negative', "Couldn't read the clipboard - paste manually.");
  }
};

// input -> confirm: classify and validate everything that can be checked
// before any network call (amount present, within balance)
const proceed = () => {
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

const friendlyError = (err: unknown): string => {
  const message = err instanceof Error ? err.message : 'Something went wrong.';
  if (message.startsWith('No mint holds enough')) {
    return 'Not enough spendable balance to cover that payment.';
  }
  return message;
};

// Applies a carve to the wallet in the only safe order: add the fresh
// note(s) first, mark the consumed inputs spent after. Returns the wallet
// id of the carved note (for the exact-match path the note already exists
// in the wallet, so it is found by url instead of re-added).
const applyCarve = async (carve: CarveResult): Promise<string> => {
  const existing = wallet.bearers.find((b) => b.url === carve.note.url);
  const toAdd: NewBearer[] = [];
  if (!existing) toAdd.push(carve.note);
  if (carve.change) toAdd.push(carve.change);
  const added = toAdd.length > 0 ? await wallet.addBearers(toAdd) : [];
  for (const consumed of carve.consumed) {
    await wallet.markSpent(consumed.id);
  }
  return existing ? existing.id : added[0].id;
};

const pay = async () => {
  const p = pendingPayment.value;
  if (!p) return;
  step.value = 'working';
  stage.value = 'Preparing the exact amount and sending the payment…';
  try {
    const payResult = await payWithBearers(
      wallet.bearers,
      p.input,
      p.kind === 'address' ? { amountMsat: p.amountMsat } : {},
    );
    stage.value = 'Confirming the result…';
    const noteId = await applyCarve(payResult.carve);
    if (payResult.rescuedNote) {
      await wallet.addBearers([payResult.rescuedNote]);
    }
    const sats = formatSats(msatToSats(payResult.amountMsat));
    if (payResult.outcome === 'settled') {
      await wallet.markSpent(noteId);
      activity.log('melt', `Paid ${sats} sats over Lightning.`);
      toast('positive', `Paid ${sats} sats.`);
      emit('sent');
    } else if (payResult.outcome === 'failed-funds-returned') {
      // the payment never happened and the note is spendable again - it
      // stays in the wallet, deliberately NOT marked spent
      activity.log('transfer', `A ${sats} sat payment failed - funds are back in your wallet.`);
      toast('warning', 'Payment failed - funds are back in your wallet.');
    } else if (payResult.outcome === 'unknown-still-pending') {
      await wallet.markSpent(noteId);
      activity.log('melt', `Payment of ${sats} sats is still in flight - the note is locked.`);
      emit('sent');
    } else {
      // note-already-spent: the mint says the note is gone; nothing was
      // paid. Lock it locally so it can't be tried again.
      await wallet.markSpent(noteId);
      activity.log('spent', `A ${sats} sat note was already spent at the mint.`);
    }
    result.value = { outcome: payResult.outcome, amountMsat: payResult.amountMsat };
    step.value = 'result';
  } catch (err) {
    if (err instanceof UncertainOutcomeError) {
      await wallet.addBearers(err.possibleOutputs);
      activity.log(
        'transfer',
        'A payment preparation could not be confirmed - possible notes stored unverified.',
      );
      inlineError.value =
        "Couldn't confirm with the mint. Your original notes are untouched, and the possible new notes are stored unverified - refresh your wallet later to reconcile.";
      toast('warning', 'Payment preparation uncertain - see the notice in the dialog.');
    } else {
      inlineError.value = friendlyError(err);
      toast('negative', inlineError.value);
    }
    step.value = 'input';
  }
};

const closeResult = () => {
  show.value = false;
};
</script>

<template>
  <q-dialog
    v-model="show"
    position="bottom"
    transition-show="slide-up"
    transition-hide="slide-down"
    :persistent="step === 'working'"
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
          :disable="step === 'working'"
        />
        <div class="col text-center">
          <span class="text-h6 text-primary">Pay with Lightning</span>
        </div>
        <div style="width: 40px" />
      </q-card-section>

      <!-- step 1: universal input -->
      <q-card-section v-if="step === 'input'" class="q-pa-md q-pt-sm">
        <q-input
          v-model="input"
          type="textarea"
          autogrow
          outlined
          color="primary"
          label="Invoice or Lightning Address"
          placeholder="lnbc1… or you@host.com"
        />
        <div class="row q-gutter-sm q-mt-sm">
          <q-btn flat dense color="primary" icon="content_paste" label="Paste" @click="paste" />
          <q-btn
            flat
            dense
            color="primary"
            icon="qr_code_scanner"
            :label="showScanner ? 'Close scanner' : 'Scan'"
            @click="showScanner = !showScanner"
          />
        </div>
        <QrScanner v-if="showScanner" class="q-mt-md" @decode="onScan" @error="onScanError" />
        <q-input
          v-if="targetKind === 'address'"
          v-model="addressAmountSats"
          class="q-mt-md"
          type="number"
          min="1"
          step="1"
          outlined
          color="primary"
          label="Amount (sats)"
        />
        <q-banner v-if="inlineError" dense class="bg-negative text-white q-mt-md rounded-borders">
          {{ inlineError }}
        </q-banner>
        <div class="row justify-end q-gutter-sm q-mt-lg">
          <q-btn v-close-popup flat label="Cancel" color="grey-5" />
          <q-btn
            unelevated
            color="primary"
            text-color="dark"
            label="Continue"
            :disable="!input.trim()"
            @click="proceed"
          />
        </div>
      </q-card-section>

      <!-- step 2: confirm -->
      <q-card-section v-else-if="step === 'confirm'" class="q-pa-md q-pt-sm">
        <q-list dense>
          <q-item>
            <q-item-section>
              <q-item-label caption class="text-grey-5">Amount</q-item-label>
              <q-item-label class="text-h6 text-primary">
                {{ pendingPayment ? formatSats(msatToSats(pendingPayment.amountMsat)) : '' }} sats
              </q-item-label>
            </q-item-section>
          </q-item>
          <q-item>
            <q-item-section>
              <q-item-label caption class="text-grey-5">To</q-item-label>
              <q-item-label class="text-grey-3" style="word-break: break-all">
                {{ truncatedInput }}
              </q-item-label>
            </q-item-section>
          </q-item>
        </q-list>
        <div class="text-caption text-grey-5 q-mt-md">
          If the mint charges a fee, it comes out of your change - you pay exactly the amount shown.
        </div>
        <div class="row justify-end q-gutter-sm q-mt-lg">
          <q-btn flat label="Back" color="grey-5" @click="step = 'input'" />
          <q-btn unelevated color="primary" text-color="dark" label="Pay now" @click="pay" />
        </div>
      </q-card-section>

      <!-- step 3: in flight -->
      <q-card-section v-else-if="step === 'working'" class="q-pa-md q-pt-sm column items-center">
        <q-spinner-dots size="48px" color="primary" class="q-my-md" />
        <div class="text-body1 text-primary">{{ stage }}</div>
        <div class="text-caption text-grey-5 q-mt-sm text-center">
          Confirming a payment can take up to a couple of minutes - please keep this open.
        </div>
        <q-linear-progress indeterminate color="primary" class="q-mt-lg full-width" />
      </q-card-section>

      <!-- step 4: outcome -->
      <q-card-section v-else class="q-pa-md q-pt-sm column items-center">
        <template v-if="result?.outcome === 'settled'">
          <q-icon name="check_circle" color="positive" size="64px" class="q-my-md" />
          <div class="text-h6 text-primary">Paid {{ resultAmountSats }} sats</div>
          <div class="text-caption text-grey-5 q-mt-sm">The payment went through.</div>
        </template>
        <template v-else-if="result?.outcome === 'failed-funds-returned'">
          <q-icon name="warning" color="warning" size="64px" class="q-my-md" />
          <div class="text-h6 text-warning">Payment failed</div>
          <div class="text-caption text-grey-5 q-mt-sm text-center">
            Nothing was paid - the funds are back in your wallet.
          </div>
        </template>
        <template v-else-if="result?.outcome === 'unknown-still-pending'">
          <q-icon name="schedule" color="info" size="64px" class="q-my-md" />
          <div class="text-h6 text-info">Payment still in flight</div>
          <div class="text-caption text-grey-5 q-mt-sm text-center">
            The note is locked - check later to see whether the payment completed.
          </div>
        </template>
        <template v-else>
          <q-icon name="error_outline" color="negative" size="64px" class="q-my-md" />
          <div class="text-h6 text-negative">Note already spent</div>
          <div class="text-caption text-grey-5 q-mt-sm text-center">
            The note for this payment was already spent - nothing was paid.
          </div>
        </template>
        <q-btn
          unelevated
          color="primary"
          text-color="dark"
          label="Done"
          class="q-mt-lg full-width"
          @click="closeResult"
        />
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
</style>
