<template>
  <div>
    <div v-if="modelValue.length" class="row q-gutter-xs q-mb-sm">
      <q-chip
        v-for="relay in modelValue"
        :key="relay"
        removable
        dense
        color="secondary"
        text-color="primary"
        :aria-label="`Remove ${relay}`"
        @remove="remove(relay)"
      >
        {{ relay }}
      </q-chip>
    </div>
    <div v-else class="text-caption text-warning q-mb-sm">
      No relays configured - a backup has nowhere to go.
    </div>
    <q-input
      v-model="draft"
      dark
      outlined
      dense
      color="primary"
      label="Add a relay"
      placeholder="wss://relay.example.com"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      :error="error !== ''"
      :error-message="error"
      class="q-mb-sm"
      @keyup.enter="add"
    />
    <q-btn
      flat
      dense
      no-caps
      color="primary"
      label="Add relay"
      :disable="draft.trim() === ''"
      @click="add"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

import { normalizeRelay } from '@/stores/nostrBackup';

const props = defineProps<{ modelValue: string[] }>();
const emit = defineEmits<{ 'update:modelValue': [relays: string[]] }>();

const draft = ref('');
const error = ref('');

const add = () => {
  error.value = '';
  try {
    const relay = normalizeRelay(draft.value);
    if (!props.modelValue.includes(relay)) {
      emit('update:modelValue', [...props.modelValue, relay]);
    }
    draft.value = '';
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'That is not a relay address.';
  }
};

const remove = (relay: string) => {
  emit(
    'update:modelValue',
    props.modelValue.filter((r) => r !== relay),
  );
};
</script>
