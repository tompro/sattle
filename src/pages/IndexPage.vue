<template>
  <q-page class="column items-center q-pa-md">
    <!-- no wallet yet -->
    <q-card
      v-if="wallet.state === 'none'"
      class="sattle-card full-width q-mt-xl q-pa-lg text-center welcome-card"
    >
      <div class="text-h5 text-primary q-mb-sm">Welcome to sattle</div>
      <div class="text-grey-5 q-mb-md">A simple wallet for Lightning bearer notes.</div>
      <q-btn
        unelevated
        color="primary"
        text-color="dark"
        label="Get started"
        @click="router.push('/welcome')"
      />
    </q-card>

    <!-- locked -->
    <q-card
      v-else-if="wallet.state === 'locked'"
      class="sattle-card full-width q-mt-xl q-pa-lg welcome-card"
    >
      <UnlockForm />
    </q-card>

    <!-- unlocked -->
    <template v-else>
      <div class="unlocked-col column full-width">
        <!-- balance zone: top ~2/3, card (and warning) centered inside -->
        <div class="balance-zone column items-center justify-center full-width">
          <q-card class="sattle-card balance-card q-pa-lg text-center">
            <div class="text-h2 text-weight-bold text-primary">
              {{ formattedBalance }}
            </div>
            <div class="text-subtitle1 text-grey-5">sats</div>
          </q-card>

          <div
            v-if="wallet.lockWarningSecondsLeft !== null"
            class="sattle-card q-pa-sm q-mt-md row items-center lock-warning"
          >
            <q-icon name="lock_clock" color="warning" class="q-mx-sm" />
            <div class="col text-grey-4">Locking in {{ wallet.lockWarningSecondsLeft }}s</div>
            <q-btn
              flat
              dense
              color="primary"
              label="Stay unlocked"
              @click="wallet.postponeLock()"
            />
          </div>
        </div>

        <!-- action row at the ~2/3 line, same width as the balance card -->
        <div class="action-row row items-center">
          <q-btn
            unelevated
            no-wrap
            color="secondary"
            text-color="primary"
            size="lg"
            icon="call_received"
            label="Receive"
            class="action-btn"
            @click="showReceive = true"
          />
          <!-- equal spacers: the fab is centered in the gap between the two
               (differently wide) labels, not just in the row -->
          <div class="btn-gap" />
          <q-btn
            fab
            color="primary"
            text-color="dark"
            size="lg"
            icon="qr_code_scanner"
            aria-label="Scan"
            @click="showScan = true"
          />
          <div class="btn-gap" />
          <q-btn
            unelevated
            no-wrap
            color="secondary"
            text-color="primary"
            size="lg"
            icon="call_made"
            label="Send"
            class="action-btn"
            @click="showSend = true"
          />
        </div>

        <!-- history zone: remaining ~1/3, entries scroll internally -->
        <div class="history-zone">
          <q-expansion-item
            dense
            class="sattle-card history-expansion"
            icon="history"
            label="History"
            header-class="text-primary text-body2"
          >
            <HistoryList />
          </q-expansion-item>
        </div>
      </div>

      <ReceiveDialog v-model="showReceive" />
      <SendDialog v-model="showSend" />
      <ReceiveTokenDialog v-model="showReceiveToken" :initial-input="scanned" />
      <PayInvoiceDialog v-model="showPayInvoice" :initial-input="scanned" />

      <q-dialog v-model="showScan">
        <q-card class="sattle-card q-pa-lg">
          <div class="text-h6 text-primary q-mb-md">Scan</div>
          <QrScanner @decode="onScanned" @error="onScanError" />
          <q-card-actions align="right">
            <q-btn v-close-popup flat label="Cancel" color="primary" />
          </q-card-actions>
        </q-card>
      </q-dialog>
    </template>
  </q-page>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { isValidNoteInput } from 'lnurlcash-kit';
import { consumePendingExternalInput, pendingExternalInput } from '@/capabilities/deepLinks';
import { useWalletStore } from '@/stores/wallet';
import UnlockForm from '@/components/UnlockForm.vue';
import HistoryList from '@/components/HistoryList.vue';
import QrScanner from '@/components/QrScanner.vue';
import ReceiveDialog from '@/components/receive/ReceiveDialog.vue';
import ReceiveTokenDialog from '@/components/receive/ReceiveTokenDialog.vue';
import SendDialog from '@/components/send/SendDialog.vue';
import PayInvoiceDialog from '@/components/send/PayInvoiceDialog.vue';

const router = useRouter();
const $q = useQuasar();
const wallet = useWalletStore();

const showReceive = ref(false);
const showSend = ref(false);
const showScan = ref(false);
const showReceiveToken = ref(false);
const showPayInvoice = ref(false);
const scanned = ref('');

const formattedBalance = computed(() =>
  wallet.balanceSats.toLocaleString(undefined, { maximumFractionDigits: 3 }),
);

// One scan button for everything: bearer notes go to receive, anything else
// (invoice, Lightning Address, LNURL) goes to pay.
const onScanned = (text: string) => {
  const value = text.trim();
  showScan.value = false;
  if (!value) return;
  scanned.value = value;
  if (isValidNoteInput(value)) {
    showReceiveToken.value = true;
  } else {
    showPayInvoice.value = true;
  }
};

const onScanError = (message: string) => {
  showScan.value = false;
  $q.notify({ type: 'negative', message, position: 'top' });
};

// Deep links (capabilities/deepLinks.ts): an inbound lightning:/lnurlw:
// link waits as pendingExternalInput until the wallet is unlocked (the
// dialogs need the keys), then opens the same dialogs a scan would.
watch(
  [pendingExternalInput, () => wallet.state],
  () => {
    if (!pendingExternalInput.value || wallet.state !== 'unlocked') return;
    const input = consumePendingExternalInput();
    if (!input) return;
    scanned.value = input.value;
    if (input.kind === 'note') {
      showReceiveToken.value = true;
    } else {
      showPayInvoice.value = true;
    }
  },
  { immediate: true },
);
</script>

<style lang="scss" scoped>
// viewport-height flex column: the q-page keeps the layout-provided
// min-height (viewport minus header) and never grows past it, so the
// unlocked page itself does not scroll. The column below fills it and
// splits it into zones.
.unlocked-col {
  flex: 1 1 0;
  min-height: 0;
}

// top ~60%: balance card (plus the conditional lock warning directly
// under it) centered as a unit. The zone height is ratio-based, so the
// warning appearing never moves the action row below.
.balance-zone {
  flex: 3 1 0;
  min-height: 0;
}

.balance-card,
.welcome-card {
  max-width: 420px;
}

.balance-card {
  width: 100%;
}

.lock-warning {
  width: 100%;
  max-width: 420px;
  border-radius: 8px;
}

// sits at the ~60% line; same width as the balance card so the Receive /
// Send edges align with the card edges, scan fab centered between them
.action-row {
  flex: none;
  width: 100%;
  max-width: 420px;
  margin: 0 auto;
}

// equal flex gaps so the scan fab sits exactly between Receive and Send
.btn-gap {
  flex: 0 0 12px;
}

// Receive and Send share the remaining width equally, so the fab lands
// dead center both between the two buttons and on the card/screen axis.
// Content is shrunk a notch (padding/font/icon) so even the wider
// "Receive" label fits on one line at 360px.
.action-btn {
  flex: 1 1 0;
  min-width: 0;
  border-radius: 16px;
  padding-left: 12px;
  padding-right: 12px;

  :deep(.q-btn__content) {
    font-size: 13px;
  }

  :deep(.q-icon) {
    font-size: 20px;
  }
}

// remaining ~40%. min-height: 0 lets the zone shrink to its flex share
// instead of growing the page; the expansion content scrolls internally.
// The top margin keeps clear air between the action row and the header.
.history-zone {
  flex: 2 1 0;
  min-height: 0;
  margin: 24px auto 0;
  width: 100%;
  max-width: 420px;
  display: flex;
  flex-direction: column;
}

.history-expansion {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-radius: 8px;

  // quieter header: smaller label, tight padding, buttons stay the focus
  :deep(.q-expansion-item__container .q-item) {
    min-height: 36px;
    padding: 4px 12px;
  }

  :deep(.q-expansion-item__container) {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  :deep(.q-expansion-item__content) {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
}
</style>
