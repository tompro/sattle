// Clipboard capability: WebView clipboard reads are unreliable on Android
// (navigator.clipboard.readText is often denied outside of paste gestures),
// so native goes through @capacitor/clipboard. Web keeps today's behavior:
// quasar's copyToClipboard (with its execCommand fallback) for writes and
// navigator.clipboard for reads.
import { Clipboard } from '@capacitor/clipboard';
import { copyToClipboard } from 'quasar';

import { isNative } from './platform';

export const writeClipboard = async (text: string): Promise<void> => {
  if (isNative()) {
    await Clipboard.write({ string: text });
    return;
  }
  await copyToClipboard(text);
};

export const readClipboard = async (): Promise<string> => {
  if (isNative()) {
    const { value } = await Clipboard.read();
    return value;
  }
  return navigator.clipboard.readText();
};
