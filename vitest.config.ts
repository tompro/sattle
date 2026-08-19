import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // the tested modules are pure crypto/codec/protocol logic - node's own
    // WebCrypto (crypto.subtle) and fetch cover everything they need, no
    // jsdom. The ops suite spins real mock-mint HTTP servers on loopback.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
