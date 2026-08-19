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
      <div class="text-h5 text-weight-bold text-primary q-ml-sm">Backup</div>
    </div>

    <q-card v-if="wallet.state !== 'unlocked'" class="sattle-card q-pa-lg">
      <div class="text-body1 text-grey-4">
        Unlock your wallet first - backup operations need the wallet's key in memory.
      </div>
    </q-card>

    <template v-else>
      <!-- recovery phrase: sattle never stores it, so there is nothing to
           reveal - the honest answer plus the paths that DO work -->
      <q-list class="sattle-card q-mb-md" bordered>
        <q-item-label header class="text-primary text-weight-bold"> Recovery phrase </q-item-label>
        <div class="q-pa-md q-pt-sm text-body2 text-grey-4">
          Your recovery phrase was shown exactly once when this wallet was created and is never
          stored anywhere - not encrypted, not on this device. It cannot be shown again. The backup
          file and nostr backup below are the recovery paths you can still set up.
        </div>
      </q-list>

      <!-- backup file -->
      <q-list class="sattle-card q-mb-md" bordered>
        <q-item-label header class="text-primary text-weight-bold"> Backup file </q-item-label>
        <div class="q-pa-md q-pt-sm">
          <div class="text-body2 text-grey-4 q-mb-sm">
            Downloads a JSON file with this wallet's notes, mint list and settings. Notes are
            encrypted - nobody can read them from the file without your recovery phrase. The mint
            list and settings are readable by anyone who opens the file.
          </div>
          <div v-if="wallet.encrypted" class="text-body2 text-grey-4 q-mb-md">
            This wallet is password-protected, so the file also carries your wallet key, encrypted
            with your password - the file alone restores a device completely.
          </div>
          <q-banner v-else dense rounded class="sattle-card text-warning q-mb-md">
            <template #avatar>
              <q-icon name="warning" color="warning" />
            </template>
            This wallet has no password, so the file does NOT include your wallet key - restoring
            takes this file plus your recovery phrase.
          </q-banner>
          <q-btn
            unelevated
            color="primary"
            text-color="dark"
            icon="download"
            label="Download backup file"
            class="full-width"
            @click="downloadBackupFile"
          />
        </div>
      </q-list>

      <!-- nostr backup -->
      <q-list class="sattle-card q-mb-md" bordered>
        <q-item-label header class="text-primary text-weight-bold"> Nostr backup </q-item-label>
        <div class="q-pa-md q-pt-sm">
          <div class="row items-center justify-between q-mb-sm">
            <div class="text-body2 text-grey-4 col q-pr-md">
              Keeps an encrypted copy of your notes, mints and settings on public nostr relays. Only
              your recovery phrase can decrypt them.
            </div>
            <q-toggle
              :model-value="nostr.enabled"
              color="primary"
              aria-label="Enable nostr backup"
              @update:model-value="nostr.setEnabled"
            />
          </div>

          <template v-if="nostr.enabled">
            <q-banner dense rounded class="sattle-card text-warning q-mb-md">
              <template #avatar>
                <q-icon name="devices" color="warning" />
              </template>
              Built for one device at a time: the newest backup replaces the older one. If you run
              two devices with the same phrase, the last one to back up wins.
            </q-banner>

            <div class="text-caption text-grey-5 q-mb-xs">Backup address</div>
            <div class="row items-center q-mb-md no-wrap">
              <code class="backup-pubkey text-grey-4 ellipsis">{{ nostr.pubkey }}</code>
              <q-btn
                flat
                dense
                round
                size="sm"
                color="primary"
                icon="content_copy"
                aria-label="Copy backup address"
                @click="copyPubkey"
              />
            </div>

            <div class="text-caption text-grey-5 q-mb-xs">Relays</div>
            <RelaysEditor v-model="relayModel" />

            <div class="row q-gutter-sm q-mt-md">
              <q-btn
                unelevated
                color="primary"
                text-color="dark"
                label="Back up now"
                class="col"
                :loading="backupBusy"
                :disable="nostr.relays.length === 0"
                @click="backUpNow"
              />
              <q-btn
                outline
                color="primary"
                label="Restore from nostr"
                class="col"
                :loading="restoreBusy"
                :disable="nostr.relays.length === 0"
                @click="restoreFromNostrAction"
              />
            </div>

            <div v-if="nostr.lastPublishAt" class="text-caption text-grey-5 q-mt-sm">
              Last backup: {{ new Date(nostr.lastPublishAt).toLocaleString() }}
            </div>
            <div v-if="nostr.lastError" class="text-caption text-negative q-mt-sm">
              {{ nostr.lastError }}
            </div>
            <div v-if="restoreSummary" class="text-caption text-positive q-mt-sm">
              {{ restoreSummary }}
            </div>
          </template>
        </div>
      </q-list>
    </template>
  </q-page>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { copyToClipboard, useQuasar } from 'quasar';

import { buildBackup } from '@/lnurlcash/storage';
import { useWalletStore } from '@/stores/wallet';
import { useNostrBackupStore } from '@/stores/nostrBackup';
import RelaysEditor from '@/components/RelaysEditor.vue';

const router = useRouter();
const $q = useQuasar();
const wallet = useWalletStore();
const nostr = useNostrBackupStore();

const toast = (type: 'positive' | 'negative', message: string): void => {
  if (typeof $q.notify === 'function') {
    $q.notify({ type, message, position: 'top', timeout: 3000 });
  }
};

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : 'Something went wrong.';

// ---- backup file ----
const downloadBackupFile = () => {
  const backup = buildBackup();
  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `sattle-backup-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
};

// ---- nostr backup ----
const relayModel = computed({
  get: () => nostr.relays,
  set: (relays: string[]) => nostr.setRelays(relays),
});

const copyPubkey = () => {
  if (!nostr.pubkey) return;
  void copyToClipboard(nostr.pubkey).then(() => toast('positive', 'Backup address copied.'));
};

const backupBusy = ref(false);
const restoreBusy = ref(false);
const restoreSummary = ref('');

const backUpNow = async () => {
  backupBusy.value = true;
  restoreSummary.value = '';
  try {
    await nostr.backupNow();
    toast('positive', 'Backup published to your relays.');
  } catch (err) {
    toast('negative', errorMessage(err));
  } finally {
    backupBusy.value = false;
  }
};

const restoreFromNostrAction = async () => {
  restoreBusy.value = true;
  restoreSummary.value = '';
  try {
    const result = await nostr.restore();
    if (result.found.length === 0) {
      restoreSummary.value = 'No backup found for this wallet on your relays.';
      return;
    }
    const parts = [
      `${result.added} note(s) added, ${result.skipped} already present`,
      `${result.trustedMintsAdded} mint(s) added`,
    ];
    if (result.settingsRestored) parts.push('settings restored');
    restoreSummary.value = `Restored: ${parts.join(', ')}.`;
    toast('positive', 'Backup restored.');
  } catch (err) {
    toast('negative', errorMessage(err));
  } finally {
    restoreBusy.value = false;
  }
};
</script>

<style lang="scss" scoped>
.backup-pubkey {
  font-size: 0.75rem;
  word-break: break-all;
}
</style>
