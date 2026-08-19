<template>
  <q-page class="q-pa-md">
    <div class="text-h5 text-weight-bold q-mb-md">Settings</div>

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
