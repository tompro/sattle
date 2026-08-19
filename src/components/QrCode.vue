<script setup lang="ts">
// QR display for invoices and bearer notes. White frame matches the
// lnurl-wallet design language (scanners need the quiet zone).
import QrcodeVue from 'qrcode.vue';

withDefaults(
  defineProps<{
    value: string;
    size?: number;
  }>(),
  { size: 220 },
);
</script>

<template>
  <div class="qr-frame">
    <qrcode-vue :value="value" :size="size" level="M" render-as="svg" />
  </div>
</template>

<style scoped>
.qr-frame {
  display: inline-block;
  padding: 6px;
  background: #ffffff;
  border-radius: 8px;
  line-height: 0;
}
</style>
