<script setup lang="ts">
// Camera QR scanner (in-browser, works in PWA and Capacitor WebView via
// getUserMedia). Emits `decode` with the scanned text; parent decides what
// the payload means (invoice, note, address...).
import { onBeforeUnmount, onMounted, ref } from 'vue';
import QrScanner from '@agicash/qr-scanner';

const emit = defineEmits<{ decode: [text: string]; error: [message: string] }>();

const videoEl = ref<HTMLVideoElement | null>(null);
const starting = ref(true);
let scanner: QrScanner | null = null;

onMounted(async () => {
  try {
    if (!(await QrScanner.hasCamera())) {
      emit('error', 'No camera available on this device.');
      starting.value = false;
      return;
    }
    if (!videoEl.value) return;
    scanner = new QrScanner(
      videoEl.value,
      (result) => emit('decode', result.data),
      { highlightScanRegion: true },
    );
    await scanner.start();
    starting.value = false;
  } catch (err) {
    starting.value = false;
    emit(
      'error',
      err instanceof Error ? err.message : 'Camera access failed.',
    );
  }
});

onBeforeUnmount(() => {
  scanner?.destroy();
  scanner = null;
});
</script>

<template>
  <div class="scanner-box">
    <video ref="videoEl" muted playsinline />
    <div v-if="starting" class="scanner-overlay">Starting camera…</div>
  </div>
</template>

<style scoped>
.scanner-box {
  position: relative;
  width: 100%;
  max-width: 320px;
  margin: 0 auto;
  border-radius: 8px;
  overflow: hidden;
  background: #001616;
}
video {
  width: 100%;
  display: block;
}
.scanner-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #55ffcc;
}
</style>
