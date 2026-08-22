<template>
  <q-page class="column items-center q-pa-md">
    <div class="text-h3 text-weight-bold text-primary q-mt-lg">sattle</div>
    <div class="text-subtitle1 text-grey-5 q-mt-sm q-mb-lg text-center">
      A wallet for lnurlcash bearer notes.
    </div>
    <q-banner
      v-if="wallet.state !== 'none'"
      class="sattle-card text-warning q-mb-md onboarding-panel"
      rounded
    >
      <template #avatar><q-icon name="warning" color="warning" /></template>
      A wallet already exists on this device. Setting up a new one replaces its key — notes
      belonging to the current wallet become unreadable until its own seed is restored again.
    </q-banner>
    <q-btn-toggle
      v-model="tab"
      spread
      no-caps
      unelevated
      toggle-color="primary"
      toggle-text-color="dark"
      color="secondary"
      text-color="primary"
      class="onboarding-panel q-mb-md"
      :options="[
        { label: 'Create new', value: 'create' },
        { label: 'Restore seed', value: 'restore' },
        { label: 'Backup file', value: 'backup' },
        { label: 'Nostr backup', value: 'nostr' },
      ]"
    />
    <q-card class="sattle-card onboarding-panel q-pa-lg">
      <KeepAlive>
        <WelcomeCreatePanel v-if="tab === 'create'" />
        <WelcomeSeedPanel v-else-if="tab === 'restore'" />
        <WelcomeNostrPanel v-else-if="tab === 'nostr'" />
        <WelcomeBackupPanel v-else />
      </KeepAlive>
    </q-card>
  </q-page>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRoute } from 'vue-router';
import { useWalletStore } from '@/stores/wallet';
import WelcomeBackupPanel from '@/components/welcome/WelcomeBackupPanel.vue';
import WelcomeCreatePanel from '@/components/welcome/WelcomeCreatePanel.vue';
import WelcomeNostrPanel from '@/components/welcome/WelcomeNostrPanel.vue';
import WelcomeSeedPanel from '@/components/welcome/WelcomeSeedPanel.vue';

type Tab = 'create' | 'restore' | 'backup' | 'nostr';
const wallet = useWalletStore();
const route = useRoute();
const tab = ref<Tab>(
  route.query.tab === 'restore' || route.query.tab === 'backup' || route.query.tab === 'nostr'
    ? route.query.tab
    : 'create',
);
</script>

<style lang="scss" scoped>
.onboarding-panel {
  width: 100%;
  max-width: 480px;
}
</style>
