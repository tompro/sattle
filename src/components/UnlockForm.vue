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

    <q-btn
      v-if="passkeyAvailable"
      outline
      color="primary"
      icon="fingerprint"
      label="Unlock with passkey"
      class="full-width q-mt-sm"
      :loading="passkeyBusy"
      @click="unlockViaPasskey"
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

import { hasPasskeySlots } from '@/lnurlcash/passkeys';
import { useWalletStore } from '@/stores/wallet';

const emit = defineEmits<{ unlocked: [] }>();

const wallet = useWalletStore();
const router = useRouter();

const password = ref('');
const showPassword = ref(false);
const busy = ref(false);
const error = ref('');

// slots live in plain localStorage - a sync read at setup is enough; they
// can only change from the security page while unlocked
const passkeyAvailable = hasPasskeySlots();
const passkeyBusy = ref(false);

const unlockViaPasskey = async () => {
  if (passkeyBusy.value) return;
  passkeyBusy.value = true;
  error.value = '';
  try {
    await wallet.unlockWithPasskey();
    emit('unlocked');
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Passkey unlock failed.';
  } finally {
    passkeyBusy.value = false;
  }
};

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
