<template>
  <q-dialog
    :model-value="modelValue"
    position="bottom"
    transition-show="slide-up"
    transition-hide="slide-down"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <q-card class="sattle-card receive-chooser q-pb-md">
      <q-card-section class="row items-center q-pb-sm">
        <div class="col text-h6">Receive</div>
        <q-btn v-close-popup flat round dense icon="close" color="primary" />
      </q-card-section>

      <q-card-section class="q-pt-sm">
        <div class="q-gutter-y-md">
          <div
            class="action-row"
            role="button"
            tabindex="0"
            @click="open('lightning')"
            @keydown.enter.prevent="open('lightning')"
            @keydown.space.prevent="open('lightning')"
          >
            <div class="row items-center no-wrap">
              <div class="icon-circle">
                <q-icon name="flash_on" color="dark" size="24px" />
              </div>
              <div class="col q-ml-md">
                <div class="text-body1 text-weight-medium">Lightning</div>
                <div class="text-caption text-grey-5">
                  Create an invoice to receive from any Lightning wallet
                </div>
              </div>
              <q-icon name="chevron_right" color="grey-5" size="24px" />
            </div>
          </div>

          <div
            class="action-row"
            role="button"
            tabindex="0"
            @click="open('token')"
            @keydown.enter.prevent="open('token')"
            @keydown.space.prevent="open('token')"
          >
            <div class="row items-center no-wrap">
              <div class="icon-circle">
                <q-icon name="receipt_long" color="dark" size="24px" />
              </div>
              <div class="col q-ml-md">
                <div class="text-body1 text-weight-medium">Bearer note</div>
                <div class="text-caption text-grey-5">
                  Paste or scan a note someone sent you
                </div>
              </div>
              <q-icon name="chevron_right" color="grey-5" size="24px" />
            </div>
          </div>
        </div>
      </q-card-section>
    </q-card>
  </q-dialog>

  <receive-lightning-dialog v-model="showLightning" @received="onReceived" />
  <receive-token-dialog v-model="showToken" @received="onReceived" />
</template>

<script setup lang="ts">
import { ref } from 'vue';

import ReceiveLightningDialog from './ReceiveLightningDialog.vue';
import ReceiveTokenDialog from './ReceiveTokenDialog.vue';

defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  received: [];
}>();

const showLightning = ref(false);
const showToken = ref(false);

const open = (which: 'lightning' | 'token') => {
  emit('update:modelValue', false);
  if (which === 'lightning') {
    showLightning.value = true;
  } else {
    showToken.value = true;
  }
};

const onReceived = () => {
  emit('received');
};
</script>

<style lang="scss" scoped>
.receive-chooser {
  width: 100%;
  max-width: 480px;
  border-radius: 16px 16px 0 0;
}

.action-row {
  background: rgba(85, 255, 204, 0.05);
  border: 1px solid rgba(85, 255, 204, 0.15);
  border-radius: 12px;
  padding: 14px 16px;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.action-row:hover,
.action-row:focus-visible {
  background: rgba(85, 255, 204, 0.1);
  border-color: rgba(85, 255, 204, 0.35);
  outline: none;
}

.icon-circle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: #55ffcc;
  flex-shrink: 0;
}
</style>
