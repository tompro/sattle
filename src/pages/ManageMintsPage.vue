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
            @click="confirmRekey(mint.server)"
          />
          <q-btn flat dense color="grey-5" label="Dismiss" @click="dismissRekey(mint.server)" />
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
import { useManageMintsPage } from '@/composables/useManageMintsPage';

const {
  addPubkey,
  addServer,
  askRemove,
  balanceAt,
  banner,
  confirmingRemove,
  confirmRekey,
  discovering,
  dismissRekey,
  doRemove,
  fingerprint,
  mints,
  removeTarget,
  router,
  suggestions,
  trustManual,
  trustSuggestion,
} = useManageMintsPage();
</script>

<style lang="scss" scoped>
.rekey-card {
  border: 1px solid var(--q-warning);
}
</style>
