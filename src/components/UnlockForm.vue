<template>
  <q-card class="sattle-card unlock-card q-pa-lg">
    <div class="column items-center q-mb-md">
      <q-icon name="lock" color="primary" size="40px" />
      <div class="text-h6 q-mt-sm">Wallet locked</div>
      <div class="text-caption text-grey-5">Enter your password to unlock.</div>
    </div>

    <q-input
      v-model="password"
      :type="showPassword ? 'text' : 'password'"
      dark
      outlined
      color="primary"
      label="Password"
      autocomplete="current-password"
      :error="error !== ''"
      :error-message="error"
      autofocus
      @keyup.enter="unlock"
    >
      <template #append>
        <q-icon
          :name="showPassword ? 'visibility_off' : 'visibility'"
          class="cursor-pointer"
          @click="showPassword = !showPassword"
        />
      </template>
    </q-input>

    <q-btn
      unelevated
      color="primary"
      text-color="dark"
      label="Unlock"
      class="full-width q-mt-md"
      :loading="busy"
      :disable="password === ''"
      @click="unlock"
    />

    <div class="text-center q-mt-md">
      <q-btn
        flat
        dense
        no-caps
        size="sm"
        color="grey-5"
        label="Restore a different wallet"
        @click="router.push('/welcome')"
      />
    </div>
  </q-card>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';

import { useWalletStore } from '@/stores/wallet';

const emit = defineEmits<{ unlocked: [] }>();

const wallet = useWalletStore();
const router = useRouter();

const password = ref('');
const showPassword = ref(false);
const busy = ref(false);
const error = ref('');

const unlock = async () => {
  if (busy.value || password.value === '') return;
  busy.value = true;
  error.value = '';
  try {
    await wallet.unlock(password.value);
    password.value = '';
    emit('unlocked');
  } catch (err) {
    // a wrong password fails WebCrypto's auth-tag check with a generic
    // DOMException - anything but the store's own "no wallet" signal means
    // the password simply didn't fit
    error.value =
      err instanceof Error && err.message === 'No wallet on this device.'
        ? err.message
        : 'Wrong password.';
  } finally {
    busy.value = false;
  }
};
</script>

<style lang="scss" scoped>
.unlock-card {
  width: 100%;
  max-width: 360px;
}
</style>
