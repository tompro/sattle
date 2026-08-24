<script setup lang="ts">
// Pay over Lightning: paste or scan a bolt11 invoice or a Lightning
// Address, confirm the amount, and the ops engine carves an exact-amount
// note out of the wallet and pays with it. The four possible outcomes are
// surfaced as distinct result screens - including the silent-failure case
// where the funds come back.
//
// Fund-safety order when applying the carve: fresh notes are added to the
// wallet BEFORE consumed inputs are marked spent.
import QrScanner from '@/components/QrScanner.vue';
import { usePayInvoiceDialog } from '@/composables/usePayInvoiceDialog';

const props = defineProps<{ modelValue: boolean; initialInput?: string }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  sent: [];
}>();

const {
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
} = usePayInvoiceDialog(props, emit);
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
