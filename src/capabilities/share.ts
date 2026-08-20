// Share capability: navigator.share doesn't exist in the Android WebView,
// so native goes through @capacitor/share and the share affordance is
// available there too. Cancellation is normalized to the web's AbortError
// DOMException so callers can treat "user dismissed the sheet" uniformly.
import { Share } from '@capacitor/share';

import { isNative } from './platform';

export const canShareText = (): boolean =>
  isNative() || (typeof navigator !== 'undefined' && typeof navigator.share === 'function');

export const shareText = async (title: string, text: string): Promise<void> => {
  if (isNative()) {
    try {
      await Share.share({ title, text, dialogTitle: title });
    } catch (err) {
      if (err instanceof Error && err.message.toLowerCase().includes('cancel')) {
        throw new DOMException(err.message, 'AbortError');
      }
      throw err;
    }
    return;
  }
  await navigator.share({ title, text });
};
