<template>
  <q-dialog
    :model-value="modelValue"
    position="bottom"
    transition-show="slide-up"
    transition-hide="slide-down"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <q-card class="sattle-card receive-dialog q-pb-md">
      <q-card-section class="row items-center q-pb-sm">
        <q-btn
          v-if="step === 'invoice'"
          flat
          round
          dense
          icon="arrow_back"
          color="primary"
          aria-label="Back"
          @click="step = 'form'"
        />
        <div class="col text-h6 q-ml-sm">Receive Lightning</div>
        <q-btn v-close-popup flat round dense icon="close" color="primary" />
      </q-card-section>

      <!-- step 1: amount + mint -->
      <q-card-section v-if="step === 'form'" class="q-pt-sm">
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
          class="q-mb-md"
        />

        <q-select
          v-model="mintChoice"
          :options="mintOptions"
          option-label="label"
          option-value="value"
          emit-value
          map-options
          dark
          outlined
          color="primary"
          label="Mint"
          class="q-mb-md"
        />

        <q-input
          v-if="mintChoice === CUSTOM_MINT"
          v-model="customMint"
          dark
          outlined
          color="primary"
          label="Mint address"
          placeholder="mint@example.com or lnurl1…"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          class="q-mb-md"
        />

        <div v-if="formError" class="text-negative q-mb-md">{{ formError }}</div>

        <q-btn
          unelevated
          color="primary"
          text-color="dark"
          label="Create invoice"
          class="full-width"
          :loading="preparing"
          :disable="!formValid"
          @click="createInvoice"
        />
      </q-card-section>

      <!-- step 2: invoice + waiting -->
      <q-card-section v-else-if="step === 'invoice' && prepared" class="q-pt-sm">
        <div class="column items-center q-mb-md">
          <qr-code :value="prepared.invoice" :size="220" />
          <q-btn
            flat
            dense
            no-caps
            icon="content_copy"
            color="primary"
            label="Copy invoice"
            class="q-mt-sm"
            @click="copyInvoice"
          />
        </div>

        <div class="text-center q-mb-md">
          <div class="text-body1">
            You receive <strong>{{ netSats.toLocaleString() }} sats</strong>
          </div>
          <div class="text-caption text-grey-5">
            Invoice amount: {{ grossSats.toLocaleString() }} sats
            <span v-if="feeSats > 0">(includes a {{ feeSats.toLocaleString() }} sat mint fee)</span>
          </div>
        </div>

        <div v-if="claimError" class="q-mb-md">
          <q-banner class="sattle-card text-negative" rounded>
            <template #avatar>
              <q-icon name="error" color="negative" />
            </template>
            {{ claimError }}
          </q-banner>
          <q-btn
            unelevated
            color="primary"
            text-color="dark"
            label="Try again"
            class="full-width q-mt-sm"
            @click="retryClaim"
          />
        </div>

        <div v-else-if="waiting" class="column items-center q-gutter-sm q-mb-sm">
          <q-spinner color="primary" size="32px" />
          <div class="text-body2 text-grey-5">Waiting for payment…</div>
          <q-btn flat no-caps dense color="grey-5" label="Stop waiting" @click="stopWaiting" />
        </div>

        <div v-else class="column items-center q-gutter-sm">
          <div class="text-caption text-grey-5 text-center">
            Not watching right now — if the invoice gets paid, the sats are still claimed into your
            wallet automatically.
          </div>
          <q-btn
            outline
            no-caps
            color="primary"
            label="Keep waiting for payment"
            @click="resumeWaiting"
          />
        </div>
      </q-card-section>

      <!-- step 3: success -->
      <q-card-section v-else class="q-pt-sm">
        <div class="column items-center text-center q-gutter-sm q-mb-md">
          <q-icon name="check_circle" color="positive" size="56px" />
          <div class="text-h5 text-weight-bold">
            Received {{ receivedSats.toLocaleString() }} sats
          </div>
          <div class="text-body2 text-grey-5">from {{ receivedServer }}</div>
        </div>

        <q-banner v-if="rotationWarning" class="sattle-card text-warning q-mb-md" rounded>
          <template #avatar>
            <q-icon name="warning" color="warning" />
          </template>
          The note is in your wallet, but it could not be fully secured yet — the sender may still
          hold a copy. You can secure it later.
        </q-banner>

        <q-btn
          v-close-popup
          unelevated
          color="primary"
          text-color="dark"
          label="Done"
          class="full-width"
        />
      </q-card-section>
    </q-card>

    <!-- first-contact mint trust prompt -->
    <q-dialog v-model="showTrust" persistent>
      <q-card class="sattle-card trust-card q-pa-lg">
        <div class="text-h6 q-mb-sm">New mint</div>
        <div class="text-body2 q-mb-md">
          This payment came from a mint you have not used before:
          <strong>{{ trustServer }}</strong>
          <template v-if="trustNodeAlias"> ({{ trustNodeAlias }})</template>
        </div>
        <div class="text-caption text-grey-5 q-mb-md">
          Trusting saves the mint so it is offered next time. You can manage trusted mints in
          Settings.
        </div>
        <div class="row q-gutter-sm justify-end">
          <q-btn flat no-caps color="grey-5" label="Just this once" @click="skipTrust" />
          <q-btn
            unelevated
            no-caps
            color="primary"
            text-color="dark"
            label="Trust this mint"
            @click="trustMint"
          />
        </div>
      </q-card>
    </q-dialog>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Notify } from 'quasar';

import QrCode from '../QrCode.vue';
import { writeClipboard } from '@/capabilities/clipboard';
import { prepareMint, claimMintedNote } from '@/lnurlcash/ops';
import type { ClaimedNote, PreparedMint } from '@/lnurlcash/ops';
import type { NewBearer } from '@/lnurlcash/types';
import { msatToSats, satsToMsat, floorMsatToSat, MSAT_PER_SAT } from '@/lnurlcash/units';
import { mintAddressCacheInfo } from '@/lnurlcash/trustedMints';
import { useWalletStore } from '@/stores/wallet';
import { useMintsStore } from '@/stores/mints';
import { useActivityStore } from '@/stores/activity';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  received: [];
}>();

const wallet = useWalletStore();
const mints = useMintsStore();
const activity = useActivityStore();

const CUSTOM_MINT = '__custom__';

// whole-sat display for received amounts (msat remainder rounded down, per
// units.ts's floorMsatToSat)
const displaySats = (msat: number): number => floorMsatToSat(msat) / MSAT_PER_SAT;

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : 'Something went wrong.';

type Step = 'form' | 'invoice' | 'success';
const step = ref<Step>('form');

// ---- form ----
const amountSats = ref<number | null>(null);
const mintChoice = ref('');
const customMint = ref('');
const preparing = ref(false);
const formError = ref('');

type MintOption = { label: string; value: string };

const mintOptions = computed<MintOption[]>(() => {
  const options: MintOption[] = [];
  const seen = new Set<string>();
  for (const mint of mints.mints) {
    const address = mint.username ? `${mint.username}@${mint.server}` : `@${mint.server}`;
    if (seen.has(address)) continue;
    seen.add(address);
    const label = mint.nodeAlias ? `${address} (${mint.nodeAlias})` : address;
    options.push({ label, value: address });
  }
  for (const publicMint of mints.PUBLIC_MINTS) {
    if (seen.has(publicMint)) continue;
    seen.add(publicMint);
    options.push({ label: publicMint, value: publicMint });
  }
  options.push({ label: 'Another mint…', value: CUSTOM_MINT });
  return options;
});

const defaultChoice = (): string => {
  const options = mintOptions.value;
  if (mints.defaultMint) {
    const match = options.find((o) => o.value.endsWith(`@${mints.defaultMint}`));
    if (match) return match.value;
  }
  const first = options[0];
  return first && first.value !== CUSTOM_MINT ? first.value : CUSTOM_MINT;
};

const formValid = computed(() => {
  if (!Number.isInteger(amountSats.value) || (amountSats.value ?? 0) < 1) return false;
  return mintChoice.value === CUSTOM_MINT
    ? customMint.value.trim() !== ''
    : mintChoice.value !== '';
});

const createInvoice = async () => {
  const sats = amountSats.value;
  if (!sats || preparing.value) return;
  preparing.value = true;
  formError.value = '';
  try {
    const mintInput = mintChoice.value === CUSTOM_MINT ? customMint.value.trim() : mintChoice.value;
    const preparedMint = await prepareMint(mintInput, satsToMsat(sats));
    if (!preparedMint.verifyUrl) {
      // without a verify URL the payment can never be auto-claimed - showing
      // a payable invoice here would strand the sats at the mint
      formError.value =
        'This mint does not support automatic claiming, so sattle cannot receive from it. Choose a different mint.';
      return;
    }
    prepared.value = preparedMint;
    claimRun = null;
    claimError.value = '';
    step.value = 'invoice';
    beginClaim();
  } catch (err) {
    formError.value = errorMessage(err);
    Notify.create({ type: 'negative', message: formError.value });
  } finally {
    preparing.value = false;
  }
};

// ---- invoice ----
const prepared = ref<PreparedMint | null>(null);
const waiting = ref(false);
const claimError = ref('');
// single in-flight claim; "stop waiting" only detaches the UI from it - the
// claim itself always runs to completion so a settled payment is never
// abandoned unclaimed
let claimRun: Promise<void> | null = null;

const grossSats = computed(() => (prepared.value ? msatToSats(prepared.value.grossMsat) : 0));
const netSats = computed(() =>
  prepared.value ? msatToSats(prepared.value.expectedNoteValueMsat) : 0,
);
const feeSats = computed(() => grossSats.value - netSats.value);

const copyInvoice = async () => {
  if (!prepared.value) return;
  try {
    await writeClipboard(prepared.value.invoice);
    Notify.create({ type: 'positive', message: 'Invoice copied.' });
  } catch (err) {
    Notify.create({ type: 'negative', message: errorMessage(err) });
  }
};

const beginClaim = () => {
  if (!prepared.value || claimRun) return;
  waiting.value = true;
  claimError.value = '';
  const current = prepared.value;
  claimRun = (async () => {
    try {
      const claimed = await claimMintedNote(current);
      await onClaimed(claimed, current);
    } catch (err) {
      claimError.value = `${errorMessage(err)} The invoice stays valid — you can try again.`;
      Notify.create({ type: 'negative', message: errorMessage(err) });
    } finally {
      waiting.value = false;
    }
  })();
};

// after a failed claim the run is over - allow a fresh attempt
const retryClaim = () => {
  claimRun = null;
  beginClaim();
};

const stopWaiting = () => {
  waiting.value = false;
};

const resumeWaiting = () => {
  if (claimRun) waiting.value = true;
};

// ---- success ----
const receivedSats = ref(0);
const receivedServer = ref('');
const rotationWarning = ref('');

const onClaimed = async (claimed: ClaimedNote, from: PreparedMint) => {
  const server = from.server;
  const wasTrusted = mints.isTrusted(server);
  const notes: NewBearer[] = claimed.possibleCopy
    ? [claimed.note, claimed.possibleCopy]
    : [claimed.note];
  await wallet.addBearers(notes);
  receivedSats.value = displaySats(claimed.note.amount);
  receivedServer.value = server;
  rotationWarning.value = claimed.rotationError ?? '';
  activity.log(
    'mint',
    `Received ${receivedSats.value.toLocaleString()} sats from ${server} over Lightning.`,
  );
  const nodeInfo = mintAddressCacheInfo(from.nodeInfo, from.username);
  if (nodeInfo) mints.cacheNodeInfo(server, nodeInfo);
  Notify.create({
    type: 'positive',
    message: `Received ${receivedSats.value.toLocaleString()} sats.`,
  });
  emit('received');
  if (props.modelValue) step.value = 'success';
  if (!wasTrusted && claimed.note.mintPubkey) {
    trustServer.value = server;
    trustPubkey.value = claimed.note.mintPubkey;
    trustNodeAlias.value = from.nodeInfo?.nodeAlias ?? '';
    showTrust.value = true;
  }
};

// ---- trust prompt ----
const showTrust = ref(false);
const trustServer = ref('');
const trustPubkey = ref('');
const trustNodeAlias = ref('');

const trustMint = () => {
  try {
    mints.trust(trustServer.value, trustPubkey.value, {
      ...(trustNodeAlias.value ? { nodeAlias: trustNodeAlias.value } : {}),
    });
    Notify.create({ type: 'positive', message: 'Mint trusted.' });
  } catch (err) {
    Notify.create({ type: 'negative', message: errorMessage(err) });
  } finally {
    showTrust.value = false;
  }
};

const skipTrust = () => {
  showTrust.value = false;
  Notify.create({
    type: 'warning',
    message:
      'Note added, but this mint is not in your trusted list yet — you can review it in Settings.',
  });
};

// fresh form every time the dialog opens; a claim already in flight keeps
// running in the background regardless
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    step.value = 'form';
    amountSats.value = null;
    customMint.value = '';
    mintChoice.value = defaultChoice();
    preparing.value = false;
    formError.value = '';
    prepared.value = null;
    waiting.value = false;
    rotationWarning.value = '';
  },
);
</script>

<style lang="scss" scoped>
.receive-dialog {
  width: 100%;
  max-width: 480px;
  border-radius: 16px 16px 0 0;
}

.trust-card {
  width: 100%;
  max-width: 400px;
}
</style>
