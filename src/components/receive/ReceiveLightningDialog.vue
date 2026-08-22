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
        <q-btn
          v-if="step === 'invoice'"
          flat
          round
          dense
          icon="arrow_back"
          color="primary"
          aria-label="Back"
          @click="step = 'form'"
        />
        <div class="col text-h6 q-ml-sm">Receive Lightning</div>
        <q-btn v-close-popup flat round dense icon="close" color="primary" />
      </q-card-section>

      <!-- step 1: amount + mint -->
      <q-card-section v-if="step === 'form'" class="q-pt-sm">
        <q-input
          v-model.number="amountSats"
          type="number"
          min="1"
          step="1"
          dark
          outlined
          color="primary"
          label="Amount"
          suffix="sats"
          class="q-mb-md"
        />

        <q-select
          v-model="mintChoice"
          :options="mintOptions"
          option-label="label"
          option-value="value"
          emit-value
          map-options
          dark
          outlined
          color="primary"
          label="Mint"
          class="q-mb-md"
        />

        <q-input
          v-if="mintChoice === CUSTOM_MINT"
          v-model="customMint"
          dark
          outlined
          color="primary"
          label="Mint address"
          placeholder="mint@example.com or lnurl1…"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          class="q-mb-md"
        />

        <div v-if="formError" class="text-negative q-mb-md">{{ formError }}</div>

        <q-btn
          unelevated
          color="primary"
          text-color="dark"
          label="Create invoice"
          class="full-width"
          :loading="preparing"
          :disable="!formValid"
          @click="createInvoice"
        />
      </q-card-section>

      <!-- step 2: invoice + waiting -->
      <q-card-section v-else-if="step === 'invoice' && prepared" class="q-pt-sm">
        <div class="column items-center q-mb-md">
          <qr-code :value="prepared.invoice" :size="220" />
          <q-btn
            flat
            dense
            no-caps
            icon="content_copy"
            color="primary"
            label="Copy invoice"
            class="q-mt-sm"
            @click="copyInvoice"
          />
        </div>

        <div class="text-center q-mb-md">
          <div class="text-body1">
            You receive <strong>{{ netSats.toLocaleString() }} sats</strong>
          </div>
          <div class="text-caption text-grey-5">
            Invoice amount: {{ grossSats.toLocaleString() }} sats
            <span v-if="feeSats > 0">(includes a {{ feeSats.toLocaleString() }} sat mint fee)</span>
          </div>
        </div>

        <div v-if="claimError" class="q-mb-md">
          <q-banner class="sattle-card text-negative" rounded>
            <template #avatar>
              <q-icon name="error" color="negative" />
            </template>
            {{ claimError }}
          </q-banner>
          <q-btn
            unelevated
            color="primary"
            text-color="dark"
            label="Try again"
            class="full-width q-mt-sm"
            @click="retryClaim"
          />
        </div>

        <div v-else-if="waiting" class="column items-center q-gutter-sm q-mb-sm">
          <q-spinner color="primary" size="32px" />
          <div class="text-body2 text-grey-5">Waiting for payment…</div>
          <q-btn flat no-caps dense color="grey-5" label="Stop waiting" @click="stopWaiting" />
        </div>

        <div v-else class="column items-center q-gutter-sm">
          <div class="text-caption text-grey-5 text-center">
            Not watching right now — if the invoice gets paid, the sats are still claimed into your
            wallet automatically.
          </div>
          <q-btn
            outline
            no-caps
            color="primary"
            label="Keep waiting for payment"
            @click="resumeWaiting"
          />
        </div>
      </q-card-section>

      <!-- step 3: success -->
      <q-card-section v-else class="q-pt-sm">
        <div class="column items-center text-center q-gutter-sm q-mb-md">
          <q-icon name="check_circle" color="positive" size="56px" />
          <div class="text-h5 text-weight-bold">
            Received {{ receivedSats.toLocaleString() }} sats
          </div>
          <div class="text-body2 text-grey-5">from {{ receivedServer }}</div>
        </div>

        <q-banner v-if="rotationWarning" class="sattle-card text-warning q-mb-md" rounded>
          <template #avatar>
            <q-icon name="warning" color="warning" />
          </template>
          The note is in your wallet, but it could not be fully secured yet — the sender may still
          hold a copy. You can secure it later.
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
          This payment came from a mint you have not used before:
          <strong>{{ trustServer }}</strong>
          <template v-if="trustNodeAlias"> ({{ trustNodeAlias }})</template>
        </div>
        <div class="text-caption text-grey-5 q-mb-md">
          Trusting saves the mint so it is offered next time. You can manage trusted mints in
          Settings.
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
import QrCode from '../QrCode.vue';
import { useReceiveLightningDialog } from '@/composables/useReceiveLightningDialog';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  received: [];
}>();

const {
  CUSTOM_MINT,
  amountSats,
  claimError,
  copyInvoice,
  createInvoice,
  customMint,
  feeSats,
  formError,
  formValid,
  grossSats,
  mintChoice,
  mintOptions,
  netSats,
  prepared,
  preparing,
  receivedSats,
  receivedServer,
  resumeWaiting,
  retryClaim,
  rotationWarning,
  showTrust,
  skipTrust,
  step,
  stopWaiting,
  trustMint,
  trustNodeAlias,
  trustServer,
  waiting,
} = useReceiveLightningDialog(props, emit);
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
