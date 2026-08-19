import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // the tested modules are pure crypto/codec helpers - node's own
    // WebCrypto (crypto.subtle) covers everything they need, no jsdom
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // protocol tests live in lnurlcash-kit (its conformance suite); app tests
    // arrive with M2 flows. Don't fail CI until then.
    passWithNoTests: true,
  },
});
