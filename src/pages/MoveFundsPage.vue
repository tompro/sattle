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
      <div class="text-h5 text-weight-bold text-primary q-ml-sm">Move funds</div>
    </div>

    <q-card class="sattle-card q-pa-md">
      <!-- step 1: form -->
      <template v-if="step === 'form'">
        <div class="text-body2 text-grey-4 q-mb-md">
          Move sats from one mint to another. The mints talk to each other over Lightning - you just
          pick where from, where to, and how much.
        </div>

        <template v-if="sourceOptions.length">
          <q-select
            v-model="sourceServer"
            :options="sourceOptions"
            option-label="label"
            option-value="value"
            emit-value
            map-options
            dark
            outlined
            color="primary"
            label="From mint"
            class="q-mb-md"
          />

          <q-select
            v-model="targetChoice"
            :options="targetOptions"
            option-label="label"
            option-value="value"
            emit-value
            map-options
            dark
            outlined
            color="primary"
            label="To mint"
            class="q-mb-md"
          />

          <q-input
            v-if="targetChoice === CUSTOM_TARGET"
            v-model="customTarget"
            dark
            outlined
            color="primary"
            label="Target mint address"
            placeholder="mint@example.com, @example.com or lnurl1…"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            class="q-mb-md"
          />

          <div class="row items-end q-gutter-sm q-mb-md">
            <q-input
              v-model.number="amountSats"
              type="number"
              min="1"
              step="1"
              dark
              outlined
              color="primary"
              label="Amount"
              suffix="sats"
              class="col"
            />
            <q-btn
              flat
              dense
              no-caps
              color="primary"
              label="Max"
              :disable="!sourceServer"
              @click="setMax"
            />
          </div>

          <q-banner v-if="inlineError" dense class="bg-negative text-white rounded-borders q-mb-md">
            {{ inlineError }}
          </q-banner>

          <q-btn
            unelevated
            color="primary"
            text-color="dark"
            label="Continue"
            class="full-width"
            :disable="!formFilled"
            @click="proceed"
          />
        </template>

        <div v-else class="text-grey-5">
          Nothing to move yet - receive some sats first, then come back.
        </div>
      </template>

      <!-- step 2: confirm -->
      <template v-else-if="step === 'confirm'">
        <q-list dense>
          <q-item>
            <q-item-section>
              <q-item-label caption class="text-grey-5">Amount</q-item-label>
              <q-item-label class="text-h6 text-primary">{{ amountSats }} sats</q-item-label>
            </q-item-section>
          </q-item>
          <q-item>
            <q-item-section>
              <q-item-label caption class="text-grey-5">From</q-item-label>
              <q-item-label class="text-grey-3">{{ sourceServer }}</q-item-label>
            </q-item-section>
          </q-item>
          <q-item>
            <q-item-section>
              <q-item-label caption class="text-grey-5">To</q-item-label>
              <q-item-label class="text-grey-3" style="word-break: break-all">
                {{ targetInput }}
              </q-item-label>
            </q-item-section>
          </q-item>
        </q-list>
        <div class="text-caption text-grey-5 q-mt-md">
          The target mint may keep a small fee - you'll see exactly what it charged once the move
          completes.
        </div>
        <div class="row justify-end q-gutter-sm q-mt-lg">
          <q-btn flat no-caps label="Back" color="grey-5" @click="step = 'form'" />
          <q-btn unelevated color="primary" text-color="dark" label="Move now" @click="move" />
        </div>
      </template>

      <!-- step 3: in flight -->
      <template v-else-if="step === 'working'">
        <div class="column items-center">
          <q-spinner-dots size="48px" color="primary" class="q-my-md" />
          <div class="text-body1 text-primary">{{ stage }}</div>
          <div class="text-caption text-grey-5 q-mt-sm text-center">
            Confirming a move can take up to a couple of minutes - please keep this open.
          </div>
          <q-linear-progress indeterminate color="primary" class="q-mt-lg full-width" />
        </div>
      </template>

      <!-- step 4: outcome -->
      <template v-else-if="result">
        <div class="column items-center text-center">
          <template v-if="result.outcome === 'settled'">
            <q-icon name="check_circle" color="positive" size="64px" class="q-my-md" />
            <div class="text-h6 text-primary">
              Moved {{ result.requestedSats.toLocaleString() }} sats
            </div>
            <div class="text-caption text-grey-5 q-mt-sm">
              {{ result.sourceServer }} &rarr; {{ result.targetServer }}
            </div>
            <div class="text-caption text-grey-5 q-mt-sm">
              <template v-if="result.feeSats > 0">
                Mint fee paid: {{ result.feeSats.toLocaleString() }} sats
              </template>
              <template v-else>No fees were charged.</template>
            </div>
          </template>

          <template v-else-if="result.outcome === 'failed-funds-returned'">
            <q-icon name="warning" color="warning" size="64px" class="q-my-md" />
            <div class="text-h6 text-warning">Move failed</div>
            <div class="text-caption text-grey-5 q-mt-sm">
              Nothing moved - the funds are back in your wallet at {{ result.sourceServer }}.
            </div>
          </template>

          <template v-else-if="result.outcome === 'unknown-still-pending'">
            <q-icon name="schedule" color="info" size="64px" class="q-my-md" />
            <div class="text-h6 text-info">Move still in flight</div>
            <div class="text-caption text-grey-5 q-mt-sm">
              The payment to {{ result.targetServer }} hasn't confirmed either way. The note on the
              source mint is locked - check later to see whether the move completed.
            </div>
            <div v-if="result.claimNoteValueSats" class="text-caption text-grey-5 q-mt-sm">
              If it settles, a note worth {{ result.claimNoteValueSats.toLocaleString() }} sats is
              waiting to be claimed at {{ result.targetServer }} - refreshing your wallet will pick
              it up.
            </div>
          </template>

          <template v-else-if="result.outcome === 'settled-claim-failed'">
            <q-icon name="error_outline" color="warning" size="64px" class="q-my-md" />
            <div class="text-h6 text-warning">Sats arrived, claim incomplete</div>
            <div class="text-caption text-grey-5 q-mt-sm">
              The {{ result.requestedSats.toLocaleString() }} sats reached
              {{ result.targetServer }}, but the wallet couldn't finish claiming the note.
              <template v-if="result.claimNoteValueSats">
                The note (worth {{ result.claimNoteValueSats.toLocaleString() }} sats) is saved
                unverified - refresh your wallet later to finish claiming it.
              </template>
              <template v-else> Refresh your wallet later to finish claiming it. </template>
            </div>
          </template>

          <template v-else>
            <q-icon name="error_outline" color="negative" size="64px" class="q-my-md" />
            <div class="text-h6 text-negative">Note already spent</div>
            <div class="text-caption text-grey-5 q-mt-sm">
              The note for this move was already spent at the mint - nothing was moved.
            </div>
          </template>

          <q-btn
            unelevated
            color="primary"
            text-color="dark"
            label="Done"
            class="q-mt-lg full-width"
            @click="router.push('/settings')"
          />
        </div>
      </template>
    </q-card>
  </q-page>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { noteK1, serverOf } from 'lnurlcash-kit';

import { transferBetweenMints } from '@/lnurlcash/ops';
import type { CarveResult, TransferOutcome } from '@/lnurlcash/ops';
import type { NewBearer } from '@/lnurlcash/types';
import { floorMsatToSat, msatToSats, satsToMsat, MSAT_PER_SAT } from '@/lnurlcash/units';
import { useWalletStore } from '@/stores/wallet';
import { useMintsStore } from '@/stores/mints';
import { useActivityStore } from '@/stores/activity';

const router = useRouter();
const $q = useQuasar();
const wallet = useWalletStore();
const mints = useMintsStore();
const activity = useActivityStore();

const toast = (type: 'positive' | 'negative' | 'warning' | 'info', message: string): void => {
  // guarded: the Notify plugin registration lives in quasar.config, outside
  // this component's control - a missing registration must not break a flow
  if (typeof $q.notify === 'function') {
    $q.notify({ type, message, position: 'top', timeout: 3000 });
  }
};

// a locked wallet holds no spendable notes (and the transfer needs the AES
// key to apply its changeset) - this page only makes sense unlocked
watch(
  () => wallet.state,
  (state) => {
    if (state !== 'unlocked') void router.replace('/');
  },
  { immediate: true },
);

const CUSTOM_TARGET = '__custom__';

// whole-sat display for msat amounts (remainder rounded down, per
// units.ts's floorMsatToSat)
const displaySats = (msat: number): number => floorMsatToSat(msat) / MSAT_PER_SAT;

// ---- source mints: only those with spendable, verified balance ----
// same eligibility the transfer op applies: not spent, verified (callback
// known), holding a real k1 (device-backed mirrors can't be melted here)
const spendableByServerMsat = computed(() => {
  const byServer = new Map<string, number>();
  for (const b of wallet.bearers) {
    if (b.spent || b.callback === '' || b.deviceId || !noteK1(b.url)) continue;
    const server = serverOf(b.url);
    byServer.set(server, (byServer.get(server) ?? 0) + b.amount);
  }
  return byServer;
});

type Option = { label: string; value: string };

const sourceOptions = computed<Option[]>(() =>
  [...spendableByServerMsat.value.entries()].map(([server, msat]) => ({
    label: `${server} - ${displaySats(msat).toLocaleString()} sats available`,
    value: server,
  })),
);

const targetOptions = computed<Option[]>(() => {
  const options: Option[] = [];
  for (const mint of mints.mints) {
    if (mint.server === sourceServer.value) continue;
    const address = mint.username ? `${mint.username}@${mint.server}` : `@${mint.server}`;
    const label = mint.nodeAlias ? `${address} (${mint.nodeAlias})` : address;
    options.push({ label, value: address });
  }
  options.push({ label: 'Another mint…', value: CUSTOM_TARGET });
  return options;
});

// ---- form ----
type Step = 'form' | 'confirm' | 'working' | 'result';
const step = ref<Step>('form');
const sourceServer = ref('');
const targetChoice = ref('');
const customTarget = ref('');
const amountSats = ref<number | null>(null);
const inlineError = ref('');
const stage = ref('');

const targetInput = computed(() =>
  targetChoice.value === CUSTOM_TARGET ? customTarget.value.trim() : targetChoice.value,
);

const formFilled = computed(
  () =>
    sourceServer.value !== '' &&
    targetInput.value !== '' &&
    Number.isInteger(amountSats.value) &&
    (amountSats.value ?? 0) >= 1,
);

const setMax = () => {
  const msat = spendableByServerMsat.value.get(sourceServer.value) ?? 0;
  amountSats.value = displaySats(msat);
};

const proceed = () => {
  inlineError.value = '';
  const sats = amountSats.value;
  if (!sats || !Number.isInteger(sats) || sats < 1) {
    inlineError.value = 'Enter how many sats to move.';
    return;
  }
  const sourceMsat = spendableByServerMsat.value.get(sourceServer.value) ?? 0;
  if (satsToMsat(sats) > sourceMsat) {
    inlineError.value = `That's more than the ${displaySats(sourceMsat).toLocaleString()} sats spendable at ${sourceServer.value}.`;
    return;
  }
  step.value = 'confirm';
};

// ---- outcome ----
type Result = {
  outcome: TransferOutcome;
  requestedSats: number;
  feeSats: number;
  sourceServer: string;
  targetServer: string;
  // value of the note still claimable at the target, when one is known
  claimNoteValueSats?: number;
};
const result = ref<Result | null>(null);

// Applies the transfer's source-side changeset in the only safe order (same
// as PayInvoiceDialog): fresh notes into the wallet BEFORE the consumed
// inputs are marked spent. Returns the wallet id of the carved note.
const applyCarve = async (carve: CarveResult): Promise<string> => {
  const existing = wallet.bearers.find((b) => b.url === carve.note.url);
  const toAdd: NewBearer[] = [];
  if (!existing) toAdd.push(carve.note);
  if (carve.change) toAdd.push(carve.change);
  const added = toAdd.length > 0 ? await wallet.addBearers(toAdd) : [];
  for (const consumed of carve.consumed) {
    await wallet.markSpent(consumed.id);
  }
  const kept = existing ?? added[0];
  if (!kept) throw new Error('The carved note was not tracked.');
  return kept.id;
};

const move = async () => {
  const sats = amountSats.value;
  if (!sats) return;
  step.value = 'working';
  stage.value = 'Asking the target mint for an invoice…';
  try {
    const transfer = await transferBetweenMints(
      wallet.bearers,
      satsToMsat(sats),
      targetInput.value,
    );
    stage.value = 'Confirming the result…';
    const carvedId = await applyCarve(transfer.carve);
    if (transfer.rescuedNote) {
      await wallet.addBearers([transfer.rescuedNote]);
    }
    const feeSats = msatToSats(transfer.quote.targetMintFeeMsat);
    if (transfer.outcome === 'settled') {
      await wallet.markSpent(carvedId);
      const claimed = transfer.mintedAtTarget;
      if (claimed) {
        const notes: NewBearer[] = claimed.possibleCopy
          ? [claimed.note, claimed.possibleCopy]
          : [claimed.note];
        await wallet.addBearers(notes);
      }
      activity.log(
        'transfer',
        `Moved ${sats.toLocaleString()} sats from ${transfer.sourceServer} to ${transfer.targetServer}.`,
      );
      toast('positive', `Moved ${sats.toLocaleString()} sats.`);
    } else if (transfer.outcome === 'failed-funds-returned') {
      // the melt provably never happened - the (re-secured) carved note
      // stays in the wallet, deliberately NOT marked spent
      activity.log(
        'transfer',
        `A ${sats.toLocaleString()} sat move to ${transfer.targetServer} failed - funds are back in your wallet.`,
      );
    } else if (transfer.outcome === 'unknown-still-pending') {
      // neither side confirmed - lock the carved note locally until a
      // refresh reconciles
      await wallet.markSpent(carvedId);
      activity.log(
        'transfer',
        `A move of ${sats.toLocaleString()} sats to ${transfer.targetServer} is still in flight - the note is locked.`,
      );
    } else if (transfer.outcome === 'settled-claim-failed') {
      // the money arrived at the target but claiming failed - the preimage
      // note (when known) is tracked unverified so the sats are never lost
      await wallet.markSpent(carvedId);
      if (transfer.claimMaterial?.note) {
        await wallet.addBearers([transfer.claimMaterial.note]);
      }
      activity.log(
        'transfer',
        `${sats.toLocaleString()} sats arrived at ${transfer.targetServer} but claiming the note failed - it is saved unverified.`,
      );
    } else {
      // note-already-spent: the mint says the note was already gone; lock
      // it locally so it can't be tried again
      await wallet.markSpent(carvedId);
      activity.log(
        'spent',
        `A ${sats.toLocaleString()} sat note was already spent at ${transfer.sourceServer}.`,
      );
    }
    const claimNote = transfer.claimMaterial?.note ?? null;
    result.value = {
      outcome: transfer.outcome,
      requestedSats: sats,
      feeSats,
      sourceServer: transfer.sourceServer,
      targetServer: transfer.targetServer,
      ...(claimNote ? { claimNoteValueSats: displaySats(claimNote.amount) } : {}),
    };
    step.value = 'result';
  } catch (err) {
    // thrown before the carve (bad target, unreachable mint, amount out of
    // range, no source cover) - every source note is untouched
    const message = err instanceof Error ? err.message : 'Something went wrong.';
    inlineError.value = message.startsWith('No mint holds enough')
      ? 'Not enough spendable balance at the source mint to cover that move.'
      : message;
    toast('negative', inlineError.value);
    step.value = 'form';
  }
};
</script>
