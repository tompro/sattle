<template>
  <q-page class="column items-center q-pa-md">
    <!-- balance hero: placeholder until M2 wires the note store -->
    <q-card class="sattle-card balance-card full-width q-mt-xl q-pa-lg text-center">
      <div class="text-h2 text-weight-bold text-primary">0</div>
      <div class="text-subtitle1 text-grey-5">sats</div>
    </q-card>

    <div class="col" />

    <!-- primary actions: visual only, protocol flows land in M2 -->
    <div class="row full-width justify-center items-center q-gutter-md q-mb-xl">
      <q-btn
        unelevated
        color="secondary"
        text-color="primary"
        icon="call_received"
        label="Receive"
        class="action-btn"
        @click="showReceive = true"
      />
      <q-btn
        fab
        color="primary"
        text-color="dark"
        icon="qr_code_scanner"
        aria-label="Scan"
        class="scan-btn"
        @click="showScan = true"
      />
      <q-btn
        unelevated
        color="secondary"
        text-color="primary"
        icon="call_made"
        label="Send"
        class="action-btn"
        @click="showSend = true"
      />
    </div>

    <q-dialog v-model="showReceive">
      <q-card class="sattle-card q-pa-lg">
        <div class="text-h6">Receive</div>
        <div class="text-grey-5 q-mt-sm">Coming in milestone M2.</div>
        <q-card-actions align="right">
          <q-btn v-close-popup flat label="Close" color="primary" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <q-dialog v-model="showSend">
      <q-card class="sattle-card q-pa-lg">
        <div class="text-h6">Send</div>
        <div class="text-grey-5 q-mt-sm">Coming in milestone M2.</div>
        <q-card-actions align="right">
          <q-btn v-close-popup flat label="Close" color="primary" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <q-dialog v-model="showScan">
      <q-card class="sattle-card q-pa-lg">
        <div class="text-h6">Scan</div>
        <div class="text-grey-5 q-mt-sm">Coming in milestone M2.</div>
        <q-card-actions align="right">
          <q-btn v-close-popup flat label="Close" color="primary" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const showReceive = ref(false);
const showSend = ref(false);
const showScan = ref(false);
</script>

<style lang="scss" scoped>
.balance-card {
  max-width: 420px;
}

.action-btn {
  min-width: 120px;
  border-radius: 8px;
}

.scan-btn {
  margin: 0 8px;
}
</style>
