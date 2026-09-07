<template>
  <q-page class="q-pa-md notes-page">
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
      <div class="text-h5 text-weight-bold text-primary q-ml-sm">Notes</div>
    </div>

    <q-banner dense class="sattle-card text-grey-4 q-mb-md">
      Bearer notes are the individual pieces that make up your balance. Select notes from one mint
      to combine them, or open a note for more actions.
    </q-banner>

    <q-card v-if="notes.length" class="sattle-card">
      <q-list separator>
        <q-item
          v-for="note in notes"
          :key="note.id"
          clickable
          class="q-py-md"
          @click="detail = note"
        >
          <q-item-section side @click.stop>
            <q-checkbox
              v-model="selectedIds"
              :val="note.id"
              color="primary"
              :disable="!canMutate(note) || busy"
              :aria-label="`Select ${formatSats(note.amount)} sat note`"
            />
          </q-item-section>
          <q-item-section>
            <q-item-label class="text-primary text-weight-medium">
              {{ formatSats(note.amount) }} sats
            </q-item-label>
            <q-item-label caption class="text-grey-5 ellipsis">
              {{ note.label || serverOf(note.url) }}
            </q-item-label>
          </q-item-section>
          <q-item-section side>
            <q-badge outline :color="statusColor(note)" :label="status(note)" />
          </q-item-section>
        </q-item>
      </q-list>
    </q-card>

    <q-card v-else class="sattle-card q-pa-xl text-center text-grey-5">
      <q-icon name="generating_tokens" size="42px" class="q-mb-sm" />
      <div>No notes in this wallet yet.</div>
    </q-card>

    <div v-if="selectedIds.length" class="merge-bar sattle-card q-pa-sm row items-center">
      <div class="col text-caption text-grey-4 q-pl-sm">{{ selectedIds.length }} selected</div>
      <q-btn
        unelevated
        no-caps
        color="primary"
        text-color="dark"
        icon="join_full"
        label="Combine"
        :disable="!canMerge || busy"
        :loading="busy"
        @click="mergeSelected"
      />
    </div>

    <q-dialog :model-value="!!detail" @update:model-value="(open) => !open && (detail = null)">
      <q-card v-if="detail" class="sattle-card note-detail">
        <q-card-section class="row items-start">
          <div class="col">
            <div class="text-h6 text-primary">{{ formatSats(detail.amount) }} sats</div>
            <div class="text-caption text-grey-5">{{ serverOf(detail.url) }}</div>
          </div>
          <q-badge outline :color="statusColor(detail)" :label="status(detail)" />
        </q-card-section>

        <q-separator dark />
        <q-list dense class="q-py-sm">
          <q-item>
            <q-item-section>
              <q-item-label caption class="text-grey-6">Note ID</q-item-label>
              <q-item-label class="text-grey-3 id-value">{{ detail.id }}</q-item-label>
            </q-item-section>
          </q-item>
          <q-item>
            <q-item-section>
              <q-item-label caption class="text-grey-6">Created</q-item-label>
              <q-item-label class="text-grey-3">{{ formatDate(detail.createdAt) }}</q-item-label>
            </q-item-section>
          </q-item>
          <q-item>
            <q-item-section>
              <q-item-label caption class="text-grey-6">Last updated</q-item-label>
              <q-item-label class="text-grey-3">{{ formatDate(detail.updatedAt) }}</q-item-label>
            </q-item-section>
          </q-item>
          <q-item v-if="detail.mintPubkey">
            <q-item-section>
              <q-item-label caption class="text-grey-6">Mint signing key</q-item-label>
              <q-item-label class="text-grey-3 id-value">{{ detail.mintPubkey }}</q-item-label>
            </q-item-section>
          </q-item>
        </q-list>

        <q-card-section class="q-pt-none">
          <q-input
            v-model="labelDraft"
            dark
            outlined
            dense
            color="primary"
            label="Private label"
            maxlength="120"
          >
            <template #append>
              <q-btn
                flat
                dense
                round
                color="primary"
                icon="save"
                aria-label="Save label"
                :disable="busy"
                @click="saveLabel(detail, labelDraft)"
              />
            </template>
          </q-input>
        </q-card-section>

        <q-card-actions class="q-px-md q-pb-md q-gutter-sm">
          <q-btn
            outline
            no-caps
            color="primary"
            icon="call_split"
            label="Split"
            :disable="!canMutate(detail) || detail.amount <= 1000 || busy"
            @click="openSplit(detail)"
          />
          <q-btn
            outline
            no-caps
            color="primary"
            icon="swap_horiz"
            label="Move"
            :disable="!canMutate(detail) || busy"
            @click="moveNote(detail)"
          />
          <q-btn
            unelevated
            no-caps
            color="primary"
            text-color="dark"
            icon="refresh"
            label="Check & refresh"
            :disable="detail.spent || !!detail.pendingMint || !!detail.deviceId || busy"
            :loading="busy"
            @click="refreshNote(detail)"
          />
        </q-card-actions>
        <q-card-section class="text-caption text-grey-6 q-pt-none">
          Checking rotates a valid note to a fresh secret, so the check itself cannot expose a
          reusable copy.
        </q-card-section>
      </q-card>
    </q-dialog>

    <q-dialog v-model="splitOpen" persistent>
      <q-card class="sattle-card q-pa-md split-dialog">
        <div class="text-h6 text-primary q-mb-xs">Split note</div>
        <div class="text-caption text-grey-5 q-mb-md">
          Enter the value of one new note. The remainder stays as another note.
        </div>
        <q-input
          v-model.number="splitAmount"
          type="number"
          min="1"
          :max="detail ? Math.ceil(detail.amount / 1000) - 1 : undefined"
          step="1"
          suffix="sats"
          label="New note amount"
          dark
          outlined
          color="primary"
          autofocus
        />
        <q-card-actions align="right" class="q-mt-md">
          <q-btn flat no-caps color="grey-5" label="Cancel" :disable="busy" v-close-popup />
          <q-btn
            unelevated
            no-caps
            color="primary"
            text-color="dark"
            label="Split"
            :loading="busy"
            @click="confirmSplit"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useNotesPage } from '@/composables/useNotesPage';

const {
  busy,
  canMerge,
  canMutate,
  confirmSplit,
  detail,
  formatSats,
  mergeSelected,
  moveNote,
  notes,
  openSplit,
  refreshNote,
  router,
  saveLabel,
  selectedIds,
  serverOf,
  splitAmount,
  splitOpen,
  status,
  statusColor,
} = useNotesPage();

const labelDraft = ref('');
watch(detail, (note) => {
  labelDraft.value = note?.label ?? '';
});
const formatDate = (timestamp: number): string => new Date(timestamp).toLocaleString();
</script>

<style lang="scss" scoped>
.notes-page {
  padding-bottom: 88px;
}

.merge-bar {
  position: fixed;
  z-index: 10;
  right: 16px;
  bottom: 16px;
  left: 16px;
  max-width: 620px;
  margin: auto;
  border-radius: 12px;
}

.note-detail {
  width: min(520px, calc(100vw - 32px));
}

.split-dialog {
  width: min(420px, calc(100vw - 32px));
}

.id-value {
  overflow-wrap: anywhere;
  font-family: monospace;
  font-size: 12px;
}
</style>
