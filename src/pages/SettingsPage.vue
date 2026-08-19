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

    <!-- group shells - entries are placeholders until their milestone
         lands (see project plan); Wallet (M4), Connections (M5) and the
         Mints group (M3) are live -->
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
      <q-item
        v-for="item in group.items"
        :key="item.label"
        :clickable="!!item.to"
        :disable="!item.to"
        @click="item.to && router.push(item.to)"
      >
        <q-item-section>{{ item.label }}</q-item-section>
        <q-item-section v-if="item.to" side>
          <q-icon name="chevron_right" color="primary" />
        </q-item-section>
      </q-item>
    </q-list>
  </q-page>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';

const router = useRouter();

type SettingsItem = { label: string; to?: string };

const groups: { label: string; items: SettingsItem[] }[] = [
  {
    label: 'Wallet',
    items: [
      { label: 'Backup', to: '/settings/backup' },
      { label: 'Security', to: '/settings/security' },
    ],
  },
  {
    label: 'Connections',
    items: [
      { label: 'Nostr Wallet Connect', to: '/settings/nwc' },
      { label: 'Nostr backup & relays', to: '/settings/backup' },
    ],
  },
  {
    label: 'Mints',
    items: [
      { label: 'Manage mints', to: '/settings/mints' },
      { label: 'Move funds', to: '/settings/move' },
    ],
  },
  {
    label: 'Preferences',
    items: [{ label: 'Appearance' }, { label: 'Language' }, { label: 'Fiat unit' }],
  },
  {
    label: 'Advanced',
    items: [
      { label: 'Notes' },
      { label: 'Offline mode' },
      { label: 'Activity log' },
      { label: 'Export / import' },
      { label: 'Developer' },
    ],
  },
  { label: 'About', items: [{ label: 'Docs' }, { label: 'Protocol' }] },
];
</script>
