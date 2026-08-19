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
      <template #avatar>
        <q-icon name="warning" color="warning" />
      </template>
      A wallet already exists on this device. Setting up a new one replaces its key —
      notes belonging to the current wallet become unreadable until its own seed is
      restored again.
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
      ]"
    />

    <q-card class="sattle-card onboarding-panel q-pa-lg">
      <!-- create -->
      <div v-if="tab === 'create'">
        <template v-if="!createdPhrase">
          <div class="text-body1 q-mb-md">
            A fresh recovery phrase is generated in your browser. It is the master key
            to your wallet — and the only way to recover your notes on another device.
          </div>
          <div class="text-caption text-grey-5 q-mb-sm">
            Password (optional) — encrypts your wallet on this device and enables
            locking. Minimum {{ MIN_PASSWORD_LENGTH }} characters. Leave empty to
            store unencrypted.
          </div>
          <q-input
            v-model="createPassword"
            type="password"
            dark
            outlined
            color="primary"
            label="Password"
            autocomplete="new-password"
            class="q-mb-sm"
          />
          <q-input
            v-if="createPassword !== ''"
            v-model="createPasswordConfirm"
            type="password"
            dark
            outlined
            color="primary"
            label="Confirm password"
            autocomplete="new-password"
            class="q-mb-sm"
          />
          <div
            v-if="createPassword !== '' && createPassword.length < MIN_PASSWORD_LENGTH"
            class="text-warning text-caption q-mb-sm"
          >
            At least {{ MIN_PASSWORD_LENGTH }} characters — this password is the only
            thing standing between an offline brute-force and your notes.
          </div>
          <div
            v-if="createPasswordConfirm !== '' && createPassword !== createPasswordConfirm"
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
            :disable="!passwordValid(createPassword, createPasswordConfirm)"
            @click="createWallet"
          />
        </template>

        <template v-else>
          <div class="text-body1 text-weight-medium q-mb-sm">
            Your recovery phrase — shown once, never stored:
          </div>
          <div class="row q-gutter-xs q-mb-md">
            <div v-for="(word, i) in createdPhrase.split(' ')" :key="i" class="word-chip">
              <span class="text-grey-5 q-mr-xs">{{ i + 1 }}.</span>{{ word }}
            </div>
          </div>
          <q-banner class="sattle-card text-warning q-mb-md" rounded>
            <template #avatar>
              <q-icon name="warning" color="warning" />
            </template>
            Write these 12 words down and keep them somewhere safe. Anyone who knows
            them can spend your notes; if you lose them, your notes are gone forever.
          </q-banner>
          <q-checkbox
            v-model="phraseConfirmed"
            color="primary"
            label="I wrote it down"
            class="q-mb-md"
          />
          <q-btn
            unelevated
            color="primary"
            text-color="dark"
            label="Continue"
            class="full-width"
            :disable="!phraseConfirmed"
            @click="finishCreate"
          />
        </template>
      </div>

      <!-- restore from seed -->
      <div v-else-if="tab === 'restore'">
        <q-input
          v-model="restorePhrase"
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
          Password (optional) — encrypts your wallet on this device and enables
          locking. Minimum {{ MIN_PASSWORD_LENGTH }} characters. Leave empty to store
          unencrypted.
        </div>
        <q-input
          v-model="restorePassword"
          type="password"
          dark
          outlined
          color="primary"
          label="Password"
          autocomplete="new-password"
          class="q-mb-sm"
        />
        <q-input
          v-if="restorePassword !== ''"
          v-model="restorePasswordConfirm"
          type="password"
          dark
          outlined
          color="primary"
          label="Confirm password"
          autocomplete="new-password"
          class="q-mb-sm"
        />
        <div
          v-if="restorePassword !== '' && restorePassword.length < MIN_PASSWORD_LENGTH"
          class="text-warning text-caption q-mb-sm"
        >
          At least {{ MIN_PASSWORD_LENGTH }} characters.
        </div>
        <div
          v-if="restorePasswordConfirm !== '' && restorePassword !== restorePasswordConfirm"
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
          :disable="
            !restorePhrase.trim() || !passwordValid(restorePassword, restorePasswordConfirm)
          "
          @click="restoreWallet"
        />
      </div>

      <!-- restore from backup file -->
      <div v-else>
        <div class="text-body1 q-mb-md">
          Sets this device up from a downloaded backup file — no recovery phrase
          needed, as long as you still know the password the backup was encrypted
          with. Notes from the file are merged into storage either way.
        </div>

        <q-banner v-if="backupSkipped" class="sattle-card text-warning q-mb-md" rounded>
          <template #avatar>
            <q-icon name="warning" color="warning" />
          </template>
          This device already has a wallet, so the backup's own key was
          <strong>not</strong> installed. Its notes were merged and will appear if the
          existing wallet is the one this backup belongs to.
        </q-banner>

        <template v-if="backupKeyRestored">
          <q-banner class="sattle-card text-warning q-mb-md" rounded>
            <template #avatar>
              <q-icon name="warning" color="warning" />
            </template>
            The backup's key was installed. Whoever wrote that file may know it — only
            continue if you trust the file's source completely. Otherwise set up a
            fresh wallet from your own recovery phrase instead.
          </q-banner>
          <q-btn
            unelevated
            color="primary"
            text-color="dark"
            label="I trust this file — continue"
            class="full-width"
            @click="proceedWithBackupKey"
          />
        </template>

        <template v-else>
          <div v-if="backupResult" class="text-positive q-mb-md">
            Backup restored: {{ backupResult.added }} note(s) added,
            {{ backupResult.skipped }} already present.
            <span v-if="!backupResult.linkingKeyRestored">
              The file carried no usable key of its own — restore its recovery phrase
              to unlock the notes.
            </span>
          </div>
          <div v-if="backupError" class="text-negative q-mb-md">{{ backupError }}</div>
          <input
            ref="backupFileInput"
            type="file"
            accept="application/json,.json"
            class="hidden"
            @change="restoreFromBackupFile"
          />
          <q-btn
            unelevated
            color="primary"
            text-color="dark"
            label="Choose backup file"
            icon="upload_file"
            class="full-width"
            :loading="backupBusy"
            @click="pickBackupFile"
          />
        </template>
      </div>
    </q-card>
  </q-page>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Notify } from 'quasar';

import { useWalletStore } from '@/stores/wallet';
import { applyBackup, MAX_BACKUP_FILE_BYTES } from '@/lnurlcash/storage';
import type { RestoreResult } from '@/lnurlcash/storage';

// the key's ciphertext sits in local storage AND travels inside every backup
// file by design, so this password is the only thing between an offline
// brute-force and every note the wallet holds - a one-character password is
// no password at all
const MIN_PASSWORD_LENGTH = 8;

type Tab = 'create' | 'restore' | 'backup';

const wallet = useWalletStore();
const router = useRouter();
const route = useRoute();

const tab = ref<Tab>(
  route.query.tab === 'restore' || route.query.tab === 'backup' ? route.query.tab : 'create',
);

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : 'Something went wrong.';

// ---- optional password (create + restore-seed share the rules) ----
const createPassword = ref('');
const createPasswordConfirm = ref('');
const restorePassword = ref('');
const restorePasswordConfirm = ref('');

const passwordValid = (password: string, confirm: string): boolean => {
  if (password === '') return true; // optional - empty means unencrypted
  return password.length >= MIN_PASSWORD_LENGTH && password === confirm;
};

// ---- create ----
const busy = ref(false);
const createdPhrase = ref<string | null>(null);
const phraseConfirmed = ref(false);

const createWallet = async () => {
  busy.value = true;
  try {
    createdPhrase.value = await wallet.create(createPassword.value || undefined);
    phraseConfirmed.value = false;
  } catch (err) {
    Notify.create({ type: 'negative', message: errorMessage(err) });
  } finally {
    busy.value = false;
  }
};

const finishCreate = () => {
  void router.push('/');
};

// ---- restore from seed ----
const restorePhrase = ref('');
const restoreError = ref('');

const restoreWallet = async () => {
  busy.value = true;
  restoreError.value = '';
  try {
    await wallet.restoreFromSeed(
      restorePhrase.value.trim().toLowerCase(),
      restorePassword.value || undefined,
    );
    Notify.create({ type: 'positive', message: 'Wallet restored.' });
    void router.push('/');
  } catch (err) {
    restoreError.value = errorMessage(err);
    Notify.create({ type: 'negative', message: restoreError.value });
  } finally {
    busy.value = false;
  }
};

// ---- restore from backup file ----
const backupFileInput = ref<HTMLInputElement | null>(null);
const backupBusy = ref(false);
const backupError = ref('');
const backupResult = ref<RestoreResult | null>(null);
const backupSkipped = ref(false);
const backupKeyRestored = ref(false);

const pickBackupFile = () => backupFileInput.value?.click();

const restoreFromBackupFile = async (event: Event) => {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  backupBusy.value = true;
  backupError.value = '';
  backupResult.value = null;
  backupSkipped.value = false;
  try {
    if (file.size > MAX_BACKUP_FILE_BYTES) {
      throw new Error('That file is far too large to be a wallet backup.');
    }
    const data: unknown = JSON.parse(await file.text());
    const result = applyBackup(data);
    if (result.linkingKeyRestored) {
      // never activated automatically: whoever wrote the file necessarily had
      // the key (encrypted or not), so the restore pauses for an explicit
      // source-trust acknowledgment
      backupKeyRestored.value = true;
      return;
    }
    if (result.linkingKeySkipped) {
      backupSkipped.value = true;
      return;
    }
    backupResult.value = result;
    Notify.create({ type: 'positive', message: 'Backup restored.' });
  } catch (err) {
    backupError.value = errorMessage(err);
    Notify.create({ type: 'negative', message: backupError.value });
  } finally {
    backupBusy.value = false;
  }
};

// the backup installed its own key into local storage behind the wallet
// store's back - a full reload re-runs the boot sequence so the app comes up
// against the restored key (unlock screen if it was password-encrypted)
const proceedWithBackupKey = () => {
  window.location.assign('/');
};
</script>

<style lang="scss" scoped>
.onboarding-panel {
  width: 100%;
  max-width: 480px;
}

.word-chip {
  background: rgba(85, 255, 204, 0.08);
  border: 1px solid rgba(85, 255, 204, 0.25);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 0.85rem;
}
</style>
