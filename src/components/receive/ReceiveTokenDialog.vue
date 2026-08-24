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
        <qr-scanner v-if="scanning" class="q-mb-md" @decode="onScan" @error="onScanError" />

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
          The mint could not be reached, so the note is stored unconfirmed at the sender's declared
          amount. Refresh it later to confirm.
        </q-banner>

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
          This note came from a mint you have not used before:
          <strong>{{ trustServer }}</strong>
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
import QrScanner from '../QrScanner.vue';
import { useReceiveTokenDialog } from '@/composables/useReceiveTokenDialog';

const props = defineProps<{ modelValue: boolean; initialInput?: string }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  received: [];
}>();

const {
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
  showTrust,
  skipTrust,
  step,
  trustMint,
  trustServer,
  unverifiedNote,
} = useReceiveTokenDialog(props, emit);
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
