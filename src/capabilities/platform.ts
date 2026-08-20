// The capability layer: the ONLY place Capacitor plugins are imported. App
// code (components, pages, stores) consumes these modules; each one no-ops
// to today's web behavior in the PWA and calls the plugin on native.
//
// Surface, deliberately minimal - only what the app already does:
// - platform.ts        isNative() detection
// - clipboard.ts       writeClipboard / readClipboard (@capacitor/clipboard)
// - share.ts           canShareText / shareText (@capacitor/share)
// - biometricUnlock.ts biometric-gated wrap of the linking key
//                      (@aparajita/capacitor-biometric-auth +
//                      @aparajita/capacitor-secure-storage, per 04)
// - deepLinks.ts       lightning:/lnurlw:/lnurlp: inbound URLs (@capacitor/app)
//
// Two documented non-abstractions:
// - QR scan: QrScanner.vue's getUserMedia camera approach works identically
//   in the Capacitor WebView (CAMERA permission is declared in the Android
//   manifest), so there is no native divergence to hide - no scan plugin.
// - Storage: the wallet's localStorage backend stays as-is this milestone.
//   The linking key at rest is AES-GCM under the holder's password exactly
//   as on web; the ONLY secret moved into native secure storage is the
//   biometric wrap secret (see biometricUnlock.ts). A full storage backend
//   migration is a separate, fund-critical change.

import { Capacitor } from '@capacitor/core';

export const isNative = (): boolean => Capacitor.isNativePlatform();
