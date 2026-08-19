<script setup lang="ts">
// Unified activity history: renders the activity store's events newest
// first, one row per wallet action. Self-contained - designed to sit inside
// a q-expansion-item on the home page.
import { computed } from 'vue';
import { useActivityStore } from '@/stores/activity';
import type { ActivityKind } from '@/lnurlcash/storage';

const activity = useActivityStore();

// the store already prepends new events, so the array is newest-first
const events = computed(() => activity.events);

const KIND_ICONS: Record<ActivityKind, string> = {
  mint: 'arrow_downward',
  receive: 'south_west',
  melt: 'north_east',
  split: 'shuffle',
  combine: 'shuffle',
  spent: 'check',
  deleted: 'delete',
  transfer: 'swap_horiz',
};

const KIND_COLORS: Record<ActivityKind, string> = {
  mint: 'positive',
  receive: 'positive',
  melt: 'primary',
  split: 'info',
  combine: 'info',
  spent: 'grey-5',
  deleted: 'negative',
  transfer: 'primary',
};

const iconFor = (kind: ActivityKind): string => KIND_ICONS[kind];
const colorFor = (kind: ActivityKind): string => KIND_COLORS[kind];

const relativeTime = (timestamp: number): string => {
  const elapsed = Date.now() - timestamp;
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(timestamp).toLocaleDateString();
};
</script>

<template>
  <q-list v-if="events.length" class="history-list">
    <q-item v-for="event in events" :key="event.id" class="q-px-sm">
      <q-item-section avatar top>
        <q-icon :name="iconFor(event.kind)" :color="colorFor(event.kind)" size="20px" />
      </q-item-section>
      <q-item-section>
        <q-item-label class="text-grey-3">{{ event.message }}</q-item-label>
        <q-item-label caption class="text-grey-6">
          {{ relativeTime(event.createdAt) }}
        </q-item-label>
      </q-item-section>
    </q-item>
  </q-list>
  <div v-else class="column items-center q-pa-lg text-grey-6">
    <q-icon name="history" size="32px" class="q-mb-sm" />
    <div>No activity yet</div>
  </div>
</template>

<style lang="scss" scoped>
.history-list {
  background: transparent;
}
</style>
