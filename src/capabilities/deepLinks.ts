// Deep-link capability: inbound bearer-note / Lightning URLs from outside
// the app, classified and handed to the home screen, which routes them into
// the existing receive/pay dialogs via their initialInput props.
//
// Sources:
// - native: Android intent filters (lightning:, lnurlw:, lnurlp: - see
//   android/app/src/main/AndroidManifest.xml) surface through
//   @capacitor/app's appUrlOpen (warm) / getLaunchUrl (cold start).
// - web/PWA: the manifest's protocol_handlers (web+lightning) land the app
//   on /?uri=<the link> - read once at boot from location.search.
//
// parseExternalInput is the pure, unit-tested half; everything Capacitor is
// confined to initDeepLinks. The pending value is consumed by IndexPage
// once the wallet is unlocked (the receive/pay flows need the keys).

import { ref } from 'vue';
import {
  isBech32Lnurl,
  isBolt11Invoice,
  isLightningAddress,
  isValidNoteInput,
} from 'lnurlcash-kit';

import { isNative } from './platform';

export type ExternalInput = { kind: 'note' | 'pay'; value: string };

// Classify an inbound link the way the Scan button classifies a scan: a
// bearer note goes to receive, anything payable (bolt11, bech32 LNURL,
// Lightning Address, lnurlp:) goes to pay. The lightning: URI scheme (and
// the PWA's web+lightning variant) is stripped; everything else is passed
// through verbatim for the dialogs' own validation.
export const parseExternalInput = (raw: string): ExternalInput | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const value = trimmed.replace(/^web\+/i, '');
  // a bearer note (lnurlw:// or bech32 lnurl carrying a k1) is never a pay
  // request - check both the raw and the lightning:-stripped form
  if (isValidNoteInput(value)) return { kind: 'note', value };
  const stripped = value.replace(/^lightning:/i, '').trim();
  if (isValidNoteInput(stripped)) return { kind: 'note', value: stripped };
  if (
    isBolt11Invoice(stripped) ||
    isBech32Lnurl(stripped) ||
    isLightningAddress(stripped) ||
    /^lnurlp:\/\//i.test(stripped)
  ) {
    return { kind: 'pay', value: stripped };
  }
  return null;
};

// the home screen watches this and opens the matching dialog as soon as the
// wallet is unlocked; until then the value simply waits (a locked wallet
// must not swallow the link)
export const pendingExternalInput = ref<ExternalInput | null>(null);

export const consumePendingExternalInput = (): ExternalInput | null => {
  const pending = pendingExternalInput.value;
  pendingExternalInput.value = null;
  return pending;
};

const receive = (rawUrl: string, navigateHome: () => void): void => {
  const input = parseExternalInput(rawUrl);
  if (!input) return;
  pendingExternalInput.value = input;
  navigateHome();
};

// Wires the platform sources into the pending value. notify is invoked
// after every accepted link so the caller can route to the home screen.
// Web is a one-shot read (protocol-handler launch); native also subscribes
// for the lifetime of the app.
export const initDeepLinks = async (navigateHome: () => void): Promise<void> => {
  if (!isNative()) {
    const uri =
      typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('uri');
    if (uri) receive(uri, navigateHome);
    return;
  }
  const { App } = await import('@capacitor/app');
  const launch = await App.getLaunchUrl();
  if (launch?.url) receive(launch.url, navigateHome);
  await App.addListener('appUrlOpen', ({ url }) => receive(url, navigateHome));
};
