<template>
  <q-page class="q-pa-md">
    <div class="row items-center q-mb-md">
      <q-btn
        flat
        dense
        round
        color="primary"
        icon="arrow_back"
        aria-label="Back"
        @click="router.push('/settings')"
      />
      <div class="text-h5 text-weight-bold text-primary q-ml-sm">Activity log</div>
    </div>

    <q-card class="sattle-card">
      <HistoryList :events="pageEvents" />
      <template v-if="pageCount > 1">
        <q-separator dark />
        <div class="row justify-center q-pa-md">
          <q-pagination
            v-model="page"
            :max="pageCount"
            :max-pages="7"
            direction-links
            color="primary"
          />
        </div>
      </template>
    </q-card>
  </q-page>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import HistoryList from '@/components/HistoryList.vue';
import { useActivityStore } from '@/stores/activity';
import { useWalletStore } from '@/stores/wallet';

const PAGE_SIZE = 20;
const router = useRouter();
const wallet = useWalletStore();
const activity = useActivityStore();
const page = ref(1);
const pageCount = computed(() => Math.max(1, Math.ceil(activity.events.length / PAGE_SIZE)));
const pageEvents = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE;
  return activity.events.slice(start, start + PAGE_SIZE);
});

watch(
  () => wallet.state,
  (state) => {
    if (state !== 'unlocked') void router.replace('/');
  },
  { immediate: true },
);
watch(pageCount, (count) => {
  if (page.value > count) page.value = count;
});
</script>
