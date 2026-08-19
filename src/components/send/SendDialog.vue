<script setup lang="ts">
// Send chooser: a bottom sheet offering the two ways to send - hand over a
// bearer note, or pay over Lightning. The actual flows live in the child
// dialogs; this component just routes to them and re-emits `sent`.
import { computed, ref } from 'vue';
import SendTokenDialog from './SendTokenDialog.vue';
import PayInvoiceDialog from './PayInvoiceDialog.vue';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  sent: [];
}>();

const show = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
});

const showToken = ref(false);
const showInvoice = ref(false);

const openToken = () => {
  show.value = false;
  showToken.value = true;
};

const openInvoice = () => {
  show.value = false;
  showInvoice.value = true;
};

const onSent = () => emit('sent');
</script>

<template>
  <q-dialog v-model="show" position="bottom" transition-show="slide-up" transition-hide="slide-down">
    <q-card class="sattle-card drawer-card full-width">
      <q-card-section class="row items-center q-pb-sm">
        <q-btn v-close-popup flat round dense icon="close" color="primary" aria-label="Close" />
        <div class="col text-center">
          <span class="text-h6 text-primary">Send</span>
        </div>
        <!-- spacer keeps the title centered against the close button -->
        <div style="width: 40px" />
      </q-card-section>

      <q-card-section class="q-pa-md q-pt-sm">
        <div class="q-gutter-y-md">
          <div
            class="action-row"
            role="button"
            tabindex="0"
            @click="openToken"
            @keydown.enter.prevent="openToken"
            @keydown.space.prevent="openToken"
          >
            <div class="row items-center no-wrap">
              <div class="icon-circle">
                <q-icon name="sticky_note_2" size="24px" />
              </div>
              <div class="col q-ml-md">
                <div class="text-body1 text-weight-medium text-primary">Bearer note</div>
                <div class="text-caption text-grey-5">Hand someone a note</div>
              </div>
              <q-icon name="chevron_right" color="grey-6" />
            </div>
          </div>

          <div
            class="action-row"
            role="button"
            tabindex="0"
            @click="openInvoice"
            @keydown.enter.prevent="openInvoice"
            @keydown.space.prevent="openInvoice"
          >
            <div class="row items-center no-wrap">
              <div class="icon-circle">
                <q-icon name="flash_on" size="24px" />
              </div>
              <div class="col q-ml-md">
                <div class="text-body1 text-weight-medium text-primary">Lightning</div>
                <div class="text-caption text-grey-5">Pay an invoice or address</div>
              </div>
              <q-icon name="chevron_right" color="grey-6" />
            </div>
          </div>
        </div>
      </q-card-section>
    </q-card>
  </q-dialog>

  <SendTokenDialog v-model="showToken" @sent="onSent" />
  <PayInvoiceDialog v-model="showInvoice" @sent="onSent" />
</template>

<style lang="scss" scoped>
.drawer-card {
  border-top-left-radius: 20px;
  border-top-right-radius: 20px;
  padding-bottom: 16px;
}

.action-row {
  background: rgba(85, 255, 204, 0.06);
  border: 1px solid rgba(85, 255, 204, 0.15);
  border-radius: 12px;
  padding: 12px 16px;
  cursor: pointer;
  transition: background 0.2s ease;

  &:active {
    background: rgba(85, 255, 204, 0.12);
  }
}

.icon-circle {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: rgba(85, 255, 204, 0.12);
  color: #55ffcc;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
</style>
