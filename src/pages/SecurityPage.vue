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
      <div class="text-h5 text-weight-bold text-primary q-ml-sm">Security</div>
    </div>

    <!-- passkeys -->
    <q-list class="sattle-card q-mb-md" bordered separator>
      <q-item-label header class="text-primary text-weight-bold">Passkeys</q-item-label>

      <q-item v-if="supported === null">
        <q-item-section class="text-grey-5">Checking passkey support…</q-item-section>
      </q-item>

      <q-item v-else-if="supported === false">
        <q-item-section>
          <q-item-label class="text-grey-3">Passkeys aren't available here</q-item-label>
          <q-item-label caption class="text-grey-5" style="white-space: normal">
            This browser has no passkey authenticator (like Touch ID, Windows Hello or Android
            biometrics) with the encryption support sattle needs. Your password unlock keeps working
            - nothing to do.
          </q-item-label>
        </q-item-section>
      </q-item>

      <template v-else>
        <q-item v-if="wallet.state !== 'unlocked'">
          <q-item-section class="text-grey-5">
            Unlock your wallet first - adding a passkey needs the wallet's key in memory.
          </q-item-section>
        </q-item>

        <template v-else>
          <q-item v-if="!slots.length">
            <q-item-section class="text-grey-5">
              No passkeys yet. A passkey lets you unlock this wallet with your device's screen lock
              instead of typing the password.
            </q-item-section>
          </q-item>
          <q-item v-for="slot in slots" :key="slot.credentialId">
            <q-item-section>
              <q-item-label class="text-grey-3">{{ slot.name || 'Passkey' }}</q-item-label>
              <q-item-label caption class="text-grey-5">
                Added {{ new Date(slot.createdAt).toLocaleDateString() }}
              </q-item-label>
            </q-item-section>
            <q-item-section side>
              <q-btn flat dense no-caps color="negative" label="Remove" @click="askRemove(slot)" />
            </q-item-section>
          </q-item>
          <div class="q-pa-md">
            <q-btn
              unelevated
              color="primary"
              text-color="dark"
              icon="fingerprint"
              label="Add a passkey"
              class="full-width"
              :loading="registerBusy"
              @click="askRegister"
            />
          </div>
        </template>
      </template>
    </q-list>

    <!-- biometric unlock (native app only - Android WebView has no WebAuthn
         platform authenticator for us, so this is the native biometric path) -->
    <q-list v-if="biometricNative" class="sattle-card q-mb-md" bordered>
      <q-item-label header class="text-primary text-weight-bold"> Biometric unlock </q-item-label>

      <q-item v-if="wallet.state !== 'unlocked'">
        <q-item-section class="text-grey-5">
          Unlock your wallet first - enabling biometric unlock needs the wallet's key in memory.
        </q-item-section>
      </q-item>

      <template v-else>
        <q-item>
          <q-item-section>
            <q-item-label class="text-grey-3">
              {{ biometricEnrolled ? 'Biometric unlock is on' : 'Biometric unlock is off' }}
            </q-item-label>
            <q-item-label caption class="text-grey-5" style="white-space: normal">
              Unlock this wallet with your device's screen lock instead of the password. The wallet
              key stays wrapped on this device; the biometric prompt gates reading it.
            </q-item-label>
          </q-item-section>
        </q-item>
        <div class="q-pa-md">
          <q-btn
            v-if="!biometricEnrolled"
            unelevated
            color="primary"
            text-color="dark"
            icon="fingerprint"
            label="Enable biometric unlock"
            class="full-width"
            :loading="biometricBusy"
            @click="doEnableBiometric"
          />
          <q-btn
            v-else
            outline
            no-caps
            color="negative"
            label="Disable biometric unlock"
            class="full-width"
            :loading="biometricBusy"
            @click="doDisableBiometric"
          />
        </div>
      </template>
    </q-list>

    <!-- auto-lock -->
    <q-list class="sattle-card q-mb-md" bordered>
      <q-item-label header class="text-primary text-weight-bold">Auto-lock</q-item-label>
      <q-item>
        <q-item-section>
          <q-item-label class="text-grey-3"> Locks after 5 minutes without activity </q-item-label>
          <q-item-label caption class="text-grey-5" style="white-space: normal">
            Applies when your wallet is password-protected. You get a 30-second warning with a "stay
            unlocked" option before it locks. The duration isn't configurable yet.
          </q-item-label>
        </q-item-section>
      </q-item>
    </q-list>

    <q-banner v-if="banner" dense class="bg-negative text-white rounded-borders q-mb-md">
      {{ banner }}
    </q-banner>

    <!-- add-passkey dialog: name it, then the authenticator ceremony runs -->
    <q-dialog v-model="registering">
      <q-card class="sattle-card q-pa-lg">
        <div class="text-h6 text-primary q-mb-sm">Add a passkey</div>
        <div class="text-body2 text-grey-4 q-mb-md">
          Your device will ask for its screen lock. The passkey only ever unlocks this wallet on
          this device - it never leaves it.
        </div>
        <q-input
          v-model="registerName"
          dark
          outlined
          color="primary"
          label="Name (optional)"
          placeholder="e.g. laptop"
          autocomplete="off"
          class="q-mb-md"
        />
        <div class="row q-gutter-sm justify-end">
          <q-btn v-close-popup flat no-caps color="grey-5" label="Cancel" />
          <q-btn
            unelevated
            no-caps
            color="primary"
            text-color="dark"
            label="Create passkey"
            :loading="registerBusy"
            @click="doRegister"
          />
        </div>
      </q-card>
    </q-dialog>

    <!-- remove confirmation -->
    <q-dialog v-model="confirmingRemove">
      <q-card class="sattle-card q-pa-lg">
        <div class="text-h6 text-primary q-mb-sm">Remove passkey</div>
        <div class="text-body2 text-grey-4 q-mb-md">
          Remove <strong>{{ removeTarget?.name || 'this passkey' }}</strong
          >? It will no longer unlock this wallet. You can remove it from your device's passkey list
          separately - the wallet can't do that for you.
        </div>
        <div class="row q-gutter-sm justify-end">
          <q-btn v-close-popup flat no-caps color="grey-5" label="Cancel" />
          <q-btn
            unelevated
            no-caps
            color="negative"
            text-color="white"
            label="Remove"
            @click="doRemove"
          />
        </div>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';

import {
  disableBiometricUnlock,
  enableBiometricUnlock,
  isBiometricUnlockEnrolled,
} from '@/capabilities/biometricUnlock';
import { isNative } from '@/capabilities/platform';
import type { PasskeySlot } from '@/lnurlcash/passkeys';
import {
  passkeySupported,
  readPasskeySlots,
  registerPasskey,
  removePasskey,
} from '@/lnurlcash/passkeys';
import { useWalletStore } from '@/stores/wallet';

const router = useRouter();
const $q = useQuasar();
const wallet = useWalletStore();

const toast = (type: 'positive' | 'negative', message: string): void => {
  if (typeof $q.notify === 'function') {
    $q.notify({ type, message, position: 'top', timeout: 3000 });
  }
};

const banner = ref('');

// null while the async probe runs - the support answer decides which of
// the three states (checking / unsupported / manage) renders
const supported = ref<boolean | null>(null);
const slots = ref<PasskeySlot[]>([]);

onMounted(async () => {
  supported.value = await passkeySupported();
  slots.value = readPasskeySlots();
});

// ---- biometric unlock (native only - see capabilities/biometricUnlock.ts) ----
const biometricNative = isNative();
const biometricEnrolled = ref(biometricNative && isBiometricUnlockEnrolled());
const biometricBusy = ref(false);

const doEnableBiometric = async () => {
  biometricBusy.value = true;
  banner.value = '';
  try {
    await enableBiometricUnlock(wallet.requireLinkingKey());
    biometricEnrolled.value = true;
    toast('positive', 'Biometric unlock enabled.');
  } catch (err) {
    banner.value = err instanceof Error ? err.message : 'Could not enable biometric unlock.';
  } finally {
    biometricBusy.value = false;
  }
};

const doDisableBiometric = async () => {
  biometricBusy.value = true;
  banner.value = '';
  try {
    await disableBiometricUnlock();
    biometricEnrolled.value = false;
    toast('positive', 'Biometric unlock disabled.');
  } catch (err) {
    banner.value = err instanceof Error ? err.message : 'Could not disable biometric unlock.';
  } finally {
    biometricBusy.value = false;
  }
};

// ---- register ----
const registering = ref(false);
const registerName = ref('');
const registerBusy = ref(false);

const askRegister = () => {
  banner.value = '';
  registerName.value = '';
  registering.value = true;
};

const doRegister = async () => {
  registerBusy.value = true;
  banner.value = '';
  try {
    const name = registerName.value.trim();
    await registerPasskey(wallet.requireLinkingKey(), name ? { name } : {});
    slots.value = readPasskeySlots();
    registering.value = false;
    toast('positive', 'Passkey added.');
  } catch (err) {
    banner.value = err instanceof Error ? err.message : 'Could not add that passkey.';
    registering.value = false;
  } finally {
    registerBusy.value = false;
  }
};

// ---- remove ----
const confirmingRemove = ref(false);
const removeTarget = ref<PasskeySlot | null>(null);

const askRemove = (slot: PasskeySlot) => {
  banner.value = '';
  removeTarget.value = slot;
  confirmingRemove.value = true;
};

const doRemove = async () => {
  confirmingRemove.value = false;
  if (!removeTarget.value) return;
  await removePasskey(removeTarget.value.credentialId);
  slots.value = readPasskeySlots();
  toast('positive', 'Passkey removed.');
};
</script>
