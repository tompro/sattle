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
        @click="router.push('/')"
      />
      <div class="text-h5 text-weight-bold text-primary q-ml-sm">Settings</div>
    </div>

    <!-- group shells only - entries are placeholders until their milestone
         lands (see project plan: M2 flows, M3 mints, M4 backup/security,
         M5 NWC) -->
    <q-list
      v-for="group in groups"
      :key="group.label"
      class="sattle-card q-mb-md"
      bordered
      separator
    >
      <q-item-label header class="text-primary text-weight-bold">
        {{ group.label }}
      </q-item-label>
      <q-item v-for="item in group.items" :key="item" disable>
        <q-item-section>{{ item }}</q-item-section>
      </q-item>
    </q-list>
  </q-page>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';

const router = useRouter();

const groups: { label: string; items: string[] }[] = [
  { label: 'Wallet', items: ['Backup', 'Security'] },
  { label: 'Connections', items: ['Nostr Wallet Connect', 'Nostr'] },
  { label: 'Mints', items: ['Manage mints', 'Move funds'] },
  { label: 'Preferences', items: ['Appearance', 'Language', 'Fiat unit'] },
  {
    label: 'Advanced',
    items: ['Notes', 'Offline mode', 'Activity log', 'Export / import', 'Developer'],
  },
  { label: 'About', items: ['Docs', 'Protocol'] },
];
</script>
