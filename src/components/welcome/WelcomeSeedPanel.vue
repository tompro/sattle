<template>
  <q-input
    v-model="phrase"
    type="textarea"
    rows="3"
    dark
    outlined
    color="primary"
    label="Your 12-word recovery phrase"
    placeholder="twelve words separated by spaces"
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
    data-1p-ignore
    data-lpignore="true"
    class="q-mb-md"
  />
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
    At least {{ MIN_PASSWORD_LENGTH }} characters.
  </div>
  <div
    v-if="confirmation !== '' && password !== confirmation"
    class="text-warning text-caption q-mb-sm"
  >
    Passwords do not match.
  </div>
  <div v-if="restoreError" class="text-negative q-mt-sm">{{ restoreError }}</div>
  <q-btn
    unelevated
    color="primary"
    text-color="dark"
    label="Restore wallet"
    class="full-width q-mt-sm"
    :loading="busy"
    :disable="!phrase.trim() || !passwordValid(password, confirmation)"
    @click="restoreWallet"
  />
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { Notify } from 'quasar';
import { useWalletStore } from '@/stores/wallet';
import { MIN_PASSWORD_LENGTH, passwordValid } from '@/composables/welcomePassword';

const wallet = useWalletStore();
const router = useRouter();
const phrase = ref('');
const password = ref('');
const confirmation = ref('');
const busy = ref(false);
const restoreError = ref('');
const restoreWallet = async (): Promise<void> => {
  busy.value = true;
  restoreError.value = '';
  try {
    await wallet.restoreFromSeed(phrase.value.trim().toLowerCase(), password.value || undefined);
    Notify.create({ type: 'positive', message: 'Wallet restored.' });
    void router.push('/');
  } catch (error) {
    restoreError.value = error instanceof Error ? error.message : 'Something went wrong.';
    Notify.create({ type: 'negative', message: restoreError.value });
  } finally {
    busy.value = false;
  }
};
</script>
