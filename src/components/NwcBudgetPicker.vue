<template>
  <div>
    <q-option-group
      :model-value="preset"
      dark
      color="primary"
      :options="presetOptions"
      @update:model-value="pickPreset"
    />
    <div v-if="preset === 'custom'" class="row q-gutter-sm q-mt-sm">
      <q-input
        v-model.number="customAmount"
        dark
        outlined
        dense
        color="primary"
        type="number"
        min="1"
        label="Sats"
        class="col"
        @update:model-value="emitCustom"
      />
      <q-select
        v-model="customPeriod"
        dark
        outlined
        dense
        color="primary"
        :options="periodOptions"
        emit-value
        map-options
        label="Per"
        class="col"
        @update:model-value="emitCustom"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
// Budget picker for NWC connections: preset sats-per-period choices plus a
// custom amount. The engine requires a concrete max (there is no
// "unlimited"), so the presets ARE the generosity ladder.
import { computed, ref } from 'vue';

import type { NwcBudget } from '@/lnurlcash/nwc';
import { satsToMsat } from '@/lnurlcash/units';
import { NWC_PERIOD_DAY_MS, NWC_PERIOD_WEEK_MS } from '@/stores/nwc';

const props = defineProps<{ modelValue: NwcBudget }>();
const emit = defineEmits<{ 'update:modelValue': [budget: NwcBudget] }>();

const PRESETS: { label: string; value: string; budget: NwcBudget }[] = [
  {
    label: '1,000 sats per day',
    value: '1000:day',
    budget: { maxMsat: satsToMsat(1_000), periodMs: NWC_PERIOD_DAY_MS },
  },
  {
    label: '10,000 sats per day',
    value: '10000:day',
    budget: { maxMsat: satsToMsat(10_000), periodMs: NWC_PERIOD_DAY_MS },
  },
  {
    label: '100,000 sats per day',
    value: '100000:day',
    budget: { maxMsat: satsToMsat(100_000), periodMs: NWC_PERIOD_DAY_MS },
  },
  {
    label: '10,000 sats per week',
    value: '10000:week',
    budget: { maxMsat: satsToMsat(10_000), periodMs: NWC_PERIOD_WEEK_MS },
  },
];

const presetOptions = [
  ...PRESETS.map(({ label, value }) => ({ label, value })),
  { label: 'Custom', value: 'custom' },
];

const periodOptions = [
  { label: 'day', value: NWC_PERIOD_DAY_MS },
  { label: 'week', value: NWC_PERIOD_WEEK_MS },
];

const matchingPreset = (budget: NwcBudget): string =>
  PRESETS.find((p) => p.budget.maxMsat === budget.maxMsat && p.budget.periodMs === budget.periodMs)
    ?.value ?? 'custom';

const preset = computed(() => matchingPreset(props.modelValue));

const customAmount = ref(Math.round(props.modelValue.maxMsat / 1000) || 1_000);
const customPeriod = ref(
  props.modelValue.periodMs === NWC_PERIOD_WEEK_MS ? NWC_PERIOD_WEEK_MS : NWC_PERIOD_DAY_MS,
);

const pickPreset = (value: string | number | null): void => {
  const picked = PRESETS.find((p) => p.value === value);
  if (picked) {
    emit('update:modelValue', { ...picked.budget });
  } else if (value === 'custom') {
    emitCustom();
  }
};

const emitCustom = (): void => {
  const sats = Math.max(1, Math.floor(Number(customAmount.value) || 0));
  emit('update:modelValue', {
    maxMsat: satsToMsat(sats),
    periodMs: customPeriod.value,
  });
};
</script>
