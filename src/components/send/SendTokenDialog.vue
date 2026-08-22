<script setup lang="ts">
// Send a bearer note: pick an amount, carve a fresh note worth exactly that
// much out of the wallet (the ops engine does the mint calls), then hand it
// over as a QR / link. The QR hides behind a tap-to-reveal cover - anyone
// who sees it can take the sats.
//
// Fund-safety order when applying the carve: the replacement notes are
// added to the wallet BEFORE the consumed ones are marked spent, so a crash
// mid-way strands a duplicate, never a secret.
import QrCode from '@/components/QrCode.vue';
import { useSendTokenDialog } from '@/composables/useSendTokenDialog';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  sent: [];
}>();

const {
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
} = useSendTokenDialog(props, emit);
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
          <q-btn
            flat
            color="grey-5"
            label="Keep in wallet"
            :disable="removing"
            @click="finishKeep"
          />
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
