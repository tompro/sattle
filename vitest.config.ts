import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // the tested modules are pure crypto/codec/protocol logic - node's own
    // WebCrypto (crypto.subtle) and fetch cover everything they need, no
    // jsdom. The ops suite spins real mock-mint HTTP servers on loopback.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Node 22 (CI) has no navigator.locks; install a passthrough
    // LockManager where it is absent so the suite is hermetic
    setupFiles: ['./vitest.setup.ts'],
  },
});
