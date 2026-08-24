<template>
  <template v-if="!createdPhrase">
    <div class="text-body1 q-mb-md">
      A fresh recovery phrase is generated in your browser. It is the master key to your wallet —
      and the only way to recover your notes on another device.
    </div>
    <div class="text-caption text-grey-5 q-mb-sm">
      Password (optional) — encrypts your wallet on this device and enables locking. Minimum
      {{ MIN_PASSWORD_LENGTH }} characters. Leave empty to store unencrypted.
    </div>
    <q-input
      v-model="password"
      type="password"
      dark
      outlined
      color="primary"
      label="Password"
      autocomplete="new-password"
      class="q-mb-sm"
    />
    <q-input
      v-if="password !== ''"
      v-model="confirmation"
      type="password"
      dark
      outlined
      color="primary"
      label="Confirm password"
      autocomplete="new-password"
      class="q-mb-sm"
    />
    <div
      v-if="password !== '' && password.length < MIN_PASSWORD_LENGTH"
      class="text-warning text-caption q-mb-sm"
    >
      At least {{ MIN_PASSWORD_LENGTH }} characters — this password is the only thing standing
      between an offline brute-force and your notes.
    </div>
    <div
      v-if="confirmation !== '' && password !== confirmation"
      class="text-warning text-caption q-mb-sm"
    >
      Passwords do not match.
    </div>
    <q-btn
      unelevated
      color="primary"
      text-color="dark"
      label="Create wallet"
      class="full-width q-mt-sm"
      :loading="busy"
      :disable="!passwordValid(password, confirmation)"
      @click="createWallet"
    />
  </template>
  <template v-else>
    <div class="text-body1 text-weight-medium q-mb-sm">
      Your recovery phrase — shown once, never stored:
    </div>
    <div class="row q-gutter-xs q-mb-md">
      <div v-for="(word, index) in createdPhrase.split(' ')" :key="index" class="word-chip">
        <span class="text-grey-5 q-mr-xs">{{ index + 1 }}.</span>{{ word }}
      </div>
    </div>
    <q-banner class="sattle-card text-warning q-mb-md" rounded>
      <template #avatar><q-icon name="warning" color="warning" /></template>
      Write these 12 words down and keep them somewhere safe. Anyone who knows them can spend your
      notes; if you lose them, your notes are gone forever.
    </q-banner>
    <q-checkbox v-model="phraseConfirmed" color="primary" label="I wrote it down" class="q-mb-md" />
    <q-btn
      unelevated
      color="primary"
      text-color="dark"
      label="Continue"
      class="full-width"
      :disable="!phraseConfirmed"
      @click="router.push('/')"
    />
  </template>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { Notify } from 'quasar';
import { useWalletStore } from '@/stores/wallet';
import { MIN_PASSWORD_LENGTH, passwordValid } from '@/composables/welcomePassword';

const wallet = useWalletStore();
const router = useRouter();
const password = ref('');
const confirmation = ref('');
const busy = ref(false);
const createdPhrase = ref<string | null>(null);
const phraseConfirmed = ref(false);
const createWallet = async (): Promise<void> => {
  busy.value = true;
  try {
    createdPhrase.value = await wallet.create(password.value || undefined);
    phraseConfirmed.value = false;
  } catch (error) {
    Notify.create({
      type: 'negative',
      message: error instanceof Error ? error.message : 'Something went wrong.',
    });
  } finally {
    busy.value = false;
  }
};
</script>

<style scoped>
.word-chip {
  background: rgba(85, 255, 204, 0.08);
  border: 1px solid rgba(85, 255, 204, 0.25);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 0.85rem;
}
</style>
