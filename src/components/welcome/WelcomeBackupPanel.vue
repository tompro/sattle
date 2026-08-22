<template>
  <div class="text-body1 q-mb-md">
    Sets this device up from a downloaded backup file — no recovery phrase needed, as long as you
    still know the password the backup was encrypted with. Notes from the file are merged into
    storage either way.
  </div>
  <q-banner v-if="keySkipped" class="sattle-card text-warning q-mb-md" rounded>
    <template #avatar><q-icon name="warning" color="warning" /></template>
    This device already has a wallet, so the backup's own key was <strong>not</strong> installed.
    Its notes were merged and will appear if the existing wallet is the one this backup belongs to.
  </q-banner>
  <template v-if="keyRestored">
    <q-banner class="sattle-card text-warning q-mb-md" rounded>
      <template #avatar><q-icon name="warning" color="warning" /></template>
      The backup's key was installed. Whoever wrote that file may know it — only continue if you
      trust the file's source completely. Otherwise set up a fresh wallet from your own recovery
      phrase instead.
    </q-banner>
    <q-btn
      unelevated
      color="primary"
      text-color="dark"
      label="I trust this file — continue"
      class="full-width"
      @click="proceed"
    />
  </template>
  <template v-else>
    <div v-if="result" class="text-positive q-mb-md">
      Backup restored: {{ result.added }} note(s) added, {{ result.skipped }} already present.
      <span v-if="!result.linkingKeyRestored">
        The file carried no usable key of its own — restore its recovery phrase to unlock the notes.
      </span>
    </div>
    <div v-if="error" class="text-negative q-mb-md">{{ error }}</div>
    <input
      ref="fileInput"
      type="file"
      accept="application/json,.json"
      class="hidden"
      @change="restoreFile"
    />
    <q-btn
      unelevated
      color="primary"
      text-color="dark"
      label="Choose backup file"
      icon="upload_file"
      class="full-width"
      :loading="busy"
      @click="fileInput?.click()"
    />
  </template>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { Notify } from 'quasar';
import { MAX_BACKUP_FILE_BYTES } from '@/lnurlcash/storage';
import type { RestoreResult } from '@/lnurlcash/storage';
import { useWalletStore } from '@/stores/wallet';

const wallet = useWalletStore();
const router = useRouter();
const fileInput = ref<HTMLInputElement | null>(null);
const busy = ref(false);
const error = ref('');
const result = ref<RestoreResult | null>(null);
const keySkipped = ref(false);
const keyRestored = ref(false);
const restoreFile = async (event: Event): Promise<void> => {
  if (!(event.currentTarget instanceof HTMLInputElement)) return;
  const input = event.currentTarget;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  busy.value = true;
  error.value = '';
  result.value = null;
  keySkipped.value = false;
  try {
    if (file.size > MAX_BACKUP_FILE_BYTES) {
      throw new Error('That file is far too large to be a wallet backup.');
    }
    const data: unknown = JSON.parse(await file.text());
    const restored = await wallet.restoreFromBackup(data);
    if (restored.linkingKeyRestored) {
      keyRestored.value = true;
      return;
    }
    if (restored.linkingKeySkipped) {
      keySkipped.value = true;
      return;
    }
    result.value = restored;
    Notify.create({ type: 'positive', message: 'Backup restored.' });
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : 'Something went wrong.';
    Notify.create({ type: 'negative', message: error.value });
  } finally {
    busy.value = false;
  }
};
const proceed = async (): Promise<void> => {
  await wallet.init();
  await router.push('/');
};
</script>
