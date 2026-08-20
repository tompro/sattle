import type { CapacitorConfig } from '@capacitor/cli';

// sattle is a pure PWA (`quasar build -m pwa` -> dist/pwa); the native app is
// that exact build wrapped. All platform divergence lives behind
// src/capabilities/ - app code never imports a Capacitor plugin directly.
//
// appId eu.protom.sattle: the developer owns protom.eu (canonical git host
// git.protom.eu). No OTA updater plugin on purpose (unlike the tbc-pwa
// reference): PWA update semantics stay 'prompt' and the wrapper ships the
// same dist/pwa, so a native release is cut like any app-store release.
//
// Signing-time TODOs (no release keystore exists yet):
// - generate the release keystore and put its SHA-256 cert fingerprint into
//   public/.well-known/assetlinks.json (placeholder value there today)
// - once the PWA hosting origin is final, add an autoVerify https
//   intent-filter for it in android/app/src/main/AndroidManifest.xml
// - iOS: `npx cap add ios` on a macOS machine; fill the Team ID in
//   public/.well-known/apple-app-site-association (stub there today)
const config: CapacitorConfig = {
  appId: 'eu.protom.sattle',
  appName: 'sattle',
  webDir: 'dist/pwa',
};

export default config;
