<template>
  <div class="text-body1 q-mb-md">
    If this wallet used nostr backup before, your notes, mints and settings are waiting on your
    relays - encrypted so only your recovery phrase can read them.
  </div>
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
  <div class="text-caption text-grey-5 q-mb-xs">Relays to look on</div>
  <RelaysEditor v-model="relays" />
  <div v-if="error" class="text-negative q-my-sm">{{ error }}</div>
  <template v-if="!found">
    <div v-if="looked" class="text-warning q-my-sm">
      No backup found for this phrase on those relays. Check the phrase and the relay list - or
      restore from a backup file instead.
    </div>
    <q-btn
      unelevated
      color="primary"
      text-color="dark"
      label="Look for a backup"
      class="full-width q-mt-md"
      :loading="busy"
      :disable="!phraseValid || relays.length === 0"
      @click="lookForBackup"
    />
  </template>
  <template v-else>
    <div class="text-body2 text-grey-4 q-my-md">
      Found a backup: {{ found.notes }} note(s), {{ found.mints }} mint(s)<template
        v-if="found.settings"
        >, settings</template
      >.
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
      At least {{ MIN_PASSWORD_LENGTH }} characters.
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
      label="Restore this backup"
      class="full-width q-mt-sm"
      :loading="busy"
      :disable="!passwordValid(password, confirmation)"
      @click="restoreBackup"
    />
  </template>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Notify } from 'quasar';
import { deriveWalletLinkingKey, isValidSeedPhrase } from '@/lnurlcash/keys';
import { backupPubkey, deriveBackupKey, fetchBackup } from '@/lnurlcash/nostrBackup';
import { useWalletStore } from '@/stores/wallet';
import { DEFAULT_NOSTR_RELAYS } from '@/stores/nostrBackup';
import RelaysEditor from '@/components/RelaysEditor.vue';
import { MIN_PASSWORD_LENGTH, passwordValid } from '@/composables/welcomePassword';

const wallet = useWalletStore();
const router = useRouter();
const phrase = ref('');
const relays = ref<string[]>([...DEFAULT_NOSTR_RELAYS]);
const password = ref('');
const confirmation = ref('');
const busy = ref(false);
const error = ref('');
const looked = ref(false);
const found = ref<{ notes: number; mints: number; settings: boolean } | null>(null);
const phraseValid = computed(() => isValidSeedPhrase(phrase.value));
const linkingKey = (): Uint8Array => deriveWalletLinkingKey(phrase.value.trim().toLowerCase());
const errorMessage = (caught: unknown): string =>
  caught instanceof Error ? caught.message : 'Something went wrong.';
const lookForBackup = async (): Promise<void> => {
  busy.value = true;
  error.value = '';
  found.value = null;
  looked.value = false;
  try {
    const secretKey = deriveBackupKey(linkingKey());
    const parts = await fetchBackup(backupPubkey(secretKey), relays.value, { secretKey });
    looked.value = true;
    if (parts.notes || parts.mints || parts.settings) {
      found.value = {
        notes: parts.notes?.length ?? 0,
        mints: parts.mints?.length ?? 0,
        settings: parts.settings !== undefined,
      };
    }
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    busy.value = false;
  }
};
const restoreBackup = async (): Promise<void> => {
  busy.value = true;
  error.value = '';
  try {
    await wallet.restoreFromNostr(
      phrase.value.trim().toLowerCase(),
      relays.value,
      password.value || undefined,
    );
    Notify.create({ type: 'positive', message: 'Backup restored - welcome back.' });
    void router.push('/');
  } catch (caught) {
    error.value = errorMessage(caught);
    Notify.create({ type: 'negative', message: error.value });
  } finally {
    busy.value = false;
  }
};
</script>
