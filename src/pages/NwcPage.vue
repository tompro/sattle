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
      <div class="text-h5 text-weight-bold text-primary q-ml-sm">Nostr Wallet Connect</div>
    </div>

    <q-card v-if="wallet.state !== 'unlocked'" class="sattle-card q-pa-lg">
      <div class="text-body1 text-grey-4">
        Unlock your wallet first - NWC connections need the wallet's key in memory.
      </div>
    </q-card>

    <template v-else>
      <!-- the honest explainer: foreground-only by design (see the nwc.ts
           façade) - this wallet is not an always-on NWC service -->
      <q-list class="sattle-card q-mb-md" bordered>
        <q-item-label header class="text-primary text-weight-bold"> How this works </q-item-label>
        <div class="q-pa-md q-pt-sm text-body2 text-grey-4">
          Nostr Wallet Connect lets other apps (like Alby) pay and receive through this wallet over
          public nostr relays. This wallet answers their requests
          <strong>only while it is open and unlocked</strong> - requests sent while it is closed
          wait on the relay and are dropped if they are more than ten minutes old when it next
          opens, never executed late. Every connection has its own spending budget.
        </div>
      </q-list>

      <!-- master switch + service state -->
      <q-list class="sattle-card q-mb-md" bordered>
        <q-item-label header class="text-primary text-weight-bold"> Service </q-item-label>
        <div class="q-pa-md q-pt-sm">
          <div class="row items-center justify-between">
            <div class="text-body2 text-grey-4 col q-pr-md">
              Answer requests from your connected apps.
            </div>
            <q-toggle
              :model-value="nwc.enabled"
              color="primary"
              aria-label="Enable Nostr Wallet Connect"
              @update:model-value="nwc.setEnabled"
            />
          </div>
          <div v-if="nwc.enabled" class="text-caption q-mt-sm" data-nwc-status>
            <span v-if="nwc.running" class="text-positive">
              Service running - answering requests for
              {{ nwc.connections.length }} connection(s).
            </span>
            <span v-else class="text-grey-5">Starting the service…</span>
          </div>
          <div v-if="nwc.lastError" class="text-caption text-negative q-mt-sm">
            {{ nwc.lastError }}
          </div>
        </div>
      </q-list>

      <!-- the one-time connection string, straight after creation - the
           client secret inside it is never stored, so this is the only
           chance to copy or scan it -->
      <q-list v-if="createdString" class="sattle-card q-mb-md created-card" bordered>
        <q-item-label header class="text-primary text-weight-bold">
          Connection created
        </q-item-label>
        <div class="q-pa-md q-pt-sm">
          <q-banner dense rounded class="sattle-card text-warning q-mb-md">
            <template #avatar>
              <q-icon name="warning" color="warning" />
            </template>
            This connection string is shown only once and cannot be recovered - copy it or scan it
            into your app now. Anyone holding it can spend within the budget you set.
          </q-banner>
          <div class="row justify-center q-mb-md">
            <QrCode :value="createdString" />
          </div>
          <div class="row items-center no-wrap q-mb-md">
            <code class="nwc-connection-string text-grey-4 ellipsis">{{ createdString }}</code>
            <q-btn
              flat
              dense
              round
              size="sm"
              color="primary"
              icon="content_copy"
              aria-label="Copy connection string"
              @click="copyConnectionString"
            />
          </div>
          <q-btn
            unelevated
            color="primary"
            text-color="dark"
            label="Done - I've saved it"
            class="full-width"
            @click="createdString = ''"
          />
        </div>
      </q-list>

      <!-- connections -->
      <q-list class="sattle-card q-mb-md" bordered separator>
        <q-item-label header class="text-primary text-weight-bold"> Connections </q-item-label>
        <q-item v-if="!nwc.connections.length">
          <q-item-section class="text-grey-5">
            No connections yet - create one below and paste its string into your app.
          </q-item-section>
        </q-item>
        <q-item v-for="connection in nwc.connections" :key="connection.clientPubkey">
          <q-item-section>
            <q-item-label class="text-grey-3">
              Client {{ fingerprint(connection.clientPubkey) }}
            </q-item-label>
            <q-item-label caption class="text-grey-5">
              {{ connection.relays.join(', ') }}
            </q-item-label>
            <q-item-label caption class="text-grey-5">
              {{ budgetLabel(connection) }} &middot; spent {{ spentLabel(connection) }} this period
            </q-item-label>
            <q-item-label caption class="text-grey-5">
              Created {{ new Date(connection.createdAt).toLocaleDateString() }}
            </q-item-label>
          </q-item-section>
          <q-item-section side>
            <div class="column q-gutter-xs">
              <q-btn
                flat
                dense
                no-caps
                color="primary"
                label="Edit budget"
                @click="askEditBudget(connection)"
              />
              <q-btn
                flat
                dense
                no-caps
                color="negative"
                label="Revoke"
                @click="askRevoke(connection)"
              />
            </div>
          </q-item-section>
        </q-item>
      </q-list>

      <!-- create -->
      <q-list v-if="!createdString" class="sattle-card q-mb-md" bordered>
        <q-item-label header class="text-primary text-weight-bold"> New connection </q-item-label>
        <div class="q-pa-md q-pt-sm">
          <div class="text-caption text-grey-5 q-mb-xs">Relays</div>
          <RelaysEditor v-model="newRelays" />
          <div class="text-caption text-grey-5 q-mb-xs q-mt-md">Spending budget</div>
          <NwcBudgetPicker v-model="newBudget" />
          <q-btn
            unelevated
            color="primary"
            text-color="dark"
            label="Create connection"
            class="full-width q-mt-md"
            :disable="newRelays.length === 0"
            @click="createNewConnection"
          />
        </div>
      </q-list>

      <q-banner v-if="banner" dense class="bg-negative text-white rounded-borders q-mb-md">
        {{ banner }}
      </q-banner>
    </template>

    <!-- edit budget -->
    <q-dialog v-model="editingBudget">
      <q-card class="sattle-card q-pa-lg">
        <div class="text-h6 text-primary q-mb-sm">Edit budget</div>
        <div class="text-body2 text-grey-4 q-mb-md">
          New limit for client {{ fingerprint(editTarget?.clientPubkey ?? '') }}.
        </div>
        <NwcBudgetPicker v-model="editBudget" />
        <div class="row q-gutter-sm justify-end q-mt-md">
          <q-btn v-close-popup flat no-caps color="grey-5" label="Cancel" />
          <q-btn
            unelevated
            no-caps
            color="primary"
            text-color="dark"
            label="Save"
            @click="saveBudget"
          />
        </div>
      </q-card>
    </q-dialog>

    <!-- revoke confirmation -->
    <q-dialog v-model="confirmingRevoke">
      <q-card class="sattle-card q-pa-lg">
        <div class="text-h6 text-primary q-mb-sm">Revoke connection</div>
        <div class="text-body2 text-grey-4 q-mb-md">
          Revoke client {{ fingerprint(revokeTarget?.clientPubkey ?? '') }}? The service stops
          answering it immediately, and its connection string stops working. The app can only
          reconnect with a new connection.
        </div>
        <div class="row q-gutter-sm justify-end">
          <q-btn v-close-popup flat no-caps color="grey-5" label="Cancel" />
          <q-btn
            unelevated
            no-caps
            color="negative"
            text-color="white"
            label="Revoke"
            @click="doRevoke"
          />
        </div>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';

import { writeClipboard } from '@/capabilities/clipboard';
import type { NwcBudget, NwcConnectionRecord } from '@/lnurlcash/nwc';
import { msatToSats } from '@/lnurlcash/units';
import { useWalletStore } from '@/stores/wallet';
import { DEFAULT_NOSTR_RELAYS } from '@/stores/nostrBackup';
import { NWC_DEFAULT_BUDGET, NWC_PERIOD_WEEK_MS, useNwcStore } from '@/stores/nwc';
import RelaysEditor from '@/components/RelaysEditor.vue';
import QrCode from '@/components/QrCode.vue';
import NwcBudgetPicker from '@/components/NwcBudgetPicker.vue';

const router = useRouter();
const $q = useQuasar();
const wallet = useWalletStore();
const nwc = useNwcStore();

const toast = (type: 'positive' | 'negative', message: string): void => {
  if (typeof $q.notify === 'function') {
    $q.notify({ type, message, position: 'top', timeout: 3000 });
  }
};

const fingerprint = (pubkey: string): string =>
  pubkey.length > 18 ? `${pubkey.slice(0, 10)}…${pubkey.slice(-8)}` : pubkey;

const formatSats = (msat: number): string =>
  msatToSats(msat).toLocaleString(undefined, { maximumFractionDigits: 3 });

const budgetLabel = (connection: NwcConnectionRecord): string =>
  `${formatSats(connection.budget.maxMsat)} sats per ${
    connection.budget.periodMs === NWC_PERIOD_WEEK_MS ? 'week' : 'day'
  }`;

// the period may already have rolled over - the engine treats an expired
// period as a full allowance again, so the display does too
const spentLabel = (connection: NwcConnectionRecord): string => {
  const expired = Date.now() - connection.spent.periodStart >= connection.budget.periodMs;
  return formatSats(expired ? 0 : connection.spent.msat);
};

// ---- create ----
const newRelays = ref<string[]>([...DEFAULT_NOSTR_RELAYS]);
const newBudget = ref<NwcBudget>({ ...NWC_DEFAULT_BUDGET });
// the one-time connection string - held only in this page's local state,
// cleared on "Done" and never re-rendered from any store
const createdString = ref('');
const banner = ref('');

const createNewConnection = (): void => {
  banner.value = '';
  try {
    createdString.value = nwc.create(newRelays.value, newBudget.value).connectionString;
  } catch (err) {
    banner.value = err instanceof Error ? err.message : 'Could not create the connection.';
  }
};

const copyConnectionString = (): void => {
  void writeClipboard(createdString.value).then(() =>
    toast('positive', 'Connection string copied.'),
  );
};

// ---- edit budget ----
const editingBudget = ref(false);
const editTarget = ref<NwcConnectionRecord | null>(null);
const editBudget = ref<NwcBudget>({ ...NWC_DEFAULT_BUDGET });

const askEditBudget = (connection: NwcConnectionRecord): void => {
  editTarget.value = connection;
  editBudget.value = { ...connection.budget };
  editingBudget.value = true;
};

const saveBudget = (): void => {
  editingBudget.value = false;
  if (!editTarget.value) return;
  nwc.updateBudget(editTarget.value.clientPubkey, editBudget.value);
  toast('positive', 'Budget updated.');
};

// ---- revoke ----
const confirmingRevoke = ref(false);
const revokeTarget = ref<NwcConnectionRecord | null>(null);

const askRevoke = (connection: NwcConnectionRecord): void => {
  revokeTarget.value = connection;
  confirmingRevoke.value = true;
};

const doRevoke = (): void => {
  confirmingRevoke.value = false;
  if (!revokeTarget.value) return;
  nwc.revoke(revokeTarget.value.clientPubkey);
  toast('positive', 'Connection revoked.');
};
</script>

<style lang="scss" scoped>
.nwc-connection-string {
  font-size: 0.75rem;
  word-break: break-all;
}

.created-card {
  border: 1px solid var(--q-primary);
}
</style>
