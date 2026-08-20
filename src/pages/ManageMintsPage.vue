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
      <div class="text-h5 text-weight-bold text-primary q-ml-sm">Manage mints</div>
    </div>

    <!-- staged key rotations first and loud: a mint advertising a NEW
         signing key is never applied silently - the holder confirms or
         dismisses it here -->
    <q-list v-if="mints.pendingRekeys.length" class="sattle-card q-mb-md rekey-card" bordered>
      <q-item-label header class="text-warning text-weight-bold">
        Key change to review
      </q-item-label>
      <q-item v-for="mint in mints.pendingRekeys" :key="mint.server" class="column items-stretch">
        <q-item-label class="text-grey-3">{{ mint.server }}</q-item-label>
        <q-item-label caption class="text-grey-5">
          Signing key {{ fingerprint(mint.mintPubkey) }} &rarr;
          {{ fingerprint(mint.pendingMintPubkey ?? '') }}
        </q-item-label>
        <q-item-label caption class="text-grey-5 q-mb-sm">
          Only confirm if you expected this mint to move to a new key.
        </q-item-label>
        <div class="row q-gutter-sm q-mb-sm">
          <q-btn
            unelevated
            dense
            color="warning"
            text-color="dark"
            label="Confirm new key"
            @click="mints.confirmRekey(mint.server)"
          />
          <q-btn
            flat
            dense
            color="grey-5"
            label="Dismiss"
            @click="mints.dismissRekey(mint.server)"
          />
        </div>
      </q-item>
    </q-list>

    <!-- trusted mints -->
    <q-list class="sattle-card q-mb-md" bordered separator>
      <q-item-label header class="text-primary text-weight-bold">Your mints</q-item-label>
      <q-item v-if="!mints.mints.length">
        <q-item-section class="text-grey-5">
          No mints yet - trust one below, or receive a note and its mint is added automatically.
        </q-item-section>
      </q-item>
      <q-item v-for="mint in mints.mints" :key="mint.server">
        <q-item-section>
          <q-item-label class="text-grey-3">
            {{ mint.server }}
            <q-badge
              v-if="mints.defaultMint === mint.server"
              color="primary"
              text-color="dark"
              label="Default"
              class="q-ml-sm"
            />
          </q-item-label>
          <q-item-label caption class="text-grey-5">
            Key {{ fingerprint(mint.mintPubkey) }}
            <template v-if="mint.nodeAlias"> &middot; {{ mint.nodeAlias }}</template>
          </q-item-label>
          <q-item-label caption class="text-grey-5">
            {{ balanceAt(mint.server) }} sats held here
          </q-item-label>
        </q-item-section>
        <q-item-section side>
          <div class="column q-gutter-xs">
            <q-btn
              v-if="mints.defaultMint === mint.server"
              flat
              dense
              no-caps
              color="grey-5"
              label="Clear default"
              @click="mints.setDefaultMint(null)"
            />
            <q-btn
              v-else
              flat
              dense
              no-caps
              color="primary"
              label="Set default"
              @click="mints.setDefaultMint(mint.server)"
            />
            <q-btn
              flat
              dense
              no-caps
              color="negative"
              label="Remove"
              @click="askRemove(mint.server)"
            />
          </div>
        </q-item-section>
      </q-item>
    </q-list>

    <!-- add a mint -->
    <q-list class="sattle-card q-mb-md" bordered>
      <q-item-label header class="text-primary text-weight-bold">Add a mint</q-item-label>
      <div class="q-pa-md q-pt-sm">
        <template v-if="suggestions.length">
          <div class="text-caption text-grey-5 q-mb-xs">One-tap suggestions</div>
          <div class="row q-gutter-sm q-mb-md">
            <q-btn
              v-for="suggestion in suggestions"
              :key="suggestion"
              outline
              dense
              no-caps
              color="primary"
              :label="suggestion"
              :loading="discovering === suggestion"
              :disable="discovering !== ''"
              @click="trustSuggestion(suggestion)"
            />
          </div>
        </template>
        <q-input
          v-model="addServer"
          dark
          outlined
          color="primary"
          label="Server"
          placeholder="mint.example.com"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          class="q-mb-sm"
        />
        <q-input
          v-model="addPubkey"
          dark
          outlined
          color="primary"
          label="Signing key (66 hex characters)"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          class="q-mb-sm"
        />
        <q-btn
          unelevated
          color="primary"
          text-color="dark"
          label="Trust this mint"
          class="full-width"
          :disable="!addServer.trim() || !addPubkey.trim()"
          @click="trustManual"
        />
      </div>
    </q-list>

    <q-banner v-if="banner" dense class="bg-negative text-white rounded-borders q-mb-md">
      {{ banner }}
    </q-banner>

    <!-- remove confirmation -->
    <q-dialog v-model="confirmingRemove">
      <q-card class="sattle-card q-pa-lg">
        <div class="text-h6 text-primary q-mb-sm">Remove mint</div>
        <div class="text-body2 text-grey-4 q-mb-md">
          Stop trusting <strong>{{ removeTarget }}</strong
          >? Notes you hold from it keep working either way.
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
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import {
  fetchMintAddress,
  fetchPayRequest,
  lightningAddressUsername,
  mintAddressUrl,
  resolveMintInput,
  serverOf,
} from 'lnurlcash-kit';

import { mintAddressCacheInfo } from '@/lnurlcash/trustedMints';
import { useMintsStore } from '@/stores/mints';
import { useWalletStore } from '@/stores/wallet';

const router = useRouter();
const $q = useQuasar();
const mints = useMintsStore();
const wallet = useWalletStore();

const toast = (type: 'positive' | 'negative' | 'warning' | 'info', message: string): void => {
  // guarded: the Notify plugin registration lives in quasar.config, outside
  // this component's control - a missing registration must not break a flow
  if (typeof $q.notify === 'function') {
    $q.notify({ type, message, position: 'top', timeout: 3000 });
  }
};

const fingerprint = (pubkey: string): string =>
  pubkey.length > 18 ? `${pubkey.slice(0, 10)}…${pubkey.slice(-8)}` : pubkey;

const balanceAt = (server: string): string =>
  (wallet.balanceByMintSats.get(server) ?? 0).toLocaleString(undefined, {
    maximumFractionDigits: 3,
  });

// ---- suggestions (PUBLIC_MINTS not yet trusted) ----
const suggestions = computed(() =>
  mints.PUBLIC_MINTS.filter(
    (address) => !mints.mints.some((m) => m.server === address.replace(/^@/, '')),
  ),
);

const banner = ref('');

// ---- manual add ----
const addServer = ref('');
const addPubkey = ref('');

const trustResult = (result: string, server: string): void => {
  if (result === 'rekey-pending') {
    toast('warning', `${server} advertised a different signing key - review it above.`);
  } else if (result === 'unchanged') {
    toast('info', `${server} is already trusted.`);
  } else {
    toast('positive', `${server} is now trusted.`);
  }
};

const trustManual = () => {
  banner.value = '';
  try {
    const result = mints.trust(addServer.value, addPubkey.value);
    trustResult(result, addServer.value.trim());
    addServer.value = '';
    addPubkey.value = '';
  } catch (err) {
    banner.value = err instanceof Error ? err.message : 'Could not trust that mint.';
  }
};

// ---- one-tap suggestion: discover the mint's signing key live, then trust ----
const discovering = ref('');

const trustSuggestion = async (address: string) => {
  if (discovering.value) return;
  banner.value = '';
  discovering.value = address;
  try {
    const url = resolveMintInput(address);
    if (!url) throw new Error('That mint address cannot be resolved.');
    // best-effort mint-address discovery, same shape-narrowing as the
    // receive flow - its payLink is authoritative when present
    let nodeInfo = null;
    let payUrl = url;
    const addressUrl = mintAddressUrl(url);
    if (addressUrl) {
      try {
        nodeInfo = await fetchMintAddress(addressUrl);
        payUrl = nodeInfo.payLink;
      } catch {
        // no mint-address support here - proceed with just the guess
      }
    }
    const info = await fetchPayRequest(payUrl);
    // the signing key is announced on the mint-address (lnurlw discovery)
    // response, not the payRequest: per the reference mint (lnurl-mint) a
    // wallet paying the mint invoice recovers the node id from the invoice
    // itself, so LUD-25 advertises mintPubkey on the withdraw side only
    const announcedKey = nodeInfo?.nodePubkey ?? info.mintPubkey;
    if (!announcedKey) {
      throw new Error("This mint didn't announce its signing key - add it manually instead.");
    }
    const server = serverOf(payUrl);
    const result = mints.trust(
      server,
      announcedKey,
      mintAddressCacheInfo(nodeInfo, lightningAddressUsername(payUrl)),
    );
    trustResult(result, server);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not reach that mint.';
    banner.value = `Could not add ${address}: ${message}`;
  } finally {
    discovering.value = '';
  }
};

// ---- remove ----
const confirmingRemove = ref(false);
const removeTarget = ref('');

const askRemove = (server: string) => {
  banner.value = '';
  removeTarget.value = server;
  confirmingRemove.value = true;
};

const doRemove = () => {
  confirmingRemove.value = false;
  try {
    mints.remove(removeTarget.value);
    if (mints.defaultMint === removeTarget.value) mints.setDefaultMint(null);
    toast('positive', `${removeTarget.value} removed.`);
  } catch {
    // a mint you hold notes from is locked against removal - say why
    banner.value = `${removeTarget.value} can't be removed while you hold notes from it - move or spend them first.`;
  }
};
</script>

<style lang="scss" scoped>
.rekey-card {
  border: 1px solid var(--q-warning);
}
</style>
