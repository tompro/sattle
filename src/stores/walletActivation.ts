import { serverOf } from 'lnurlcash-kit';

import { grandfatherTrustedMint } from '@/lnurlcash/trustedMints';
import type { Bearer } from '@/lnurlcash/types';

export const restoreHeldMintTrust = async (
  bearers: readonly Bearer[],
  ownerId: string,
  onError: (message: string) => void,
): Promise<void> => {
  for (const bearer of bearers) {
    if (!bearer.mintPubkey) continue;
    try {
      await grandfatherTrustedMint(serverOf(bearer.url), bearer.mintPubkey, ownerId);
    } catch (error) {
      onError(
        error instanceof Error
          ? `Funds loaded, but mint trust could not be restored: ${error.message}`
          : 'Funds loaded, but mint trust could not be restored.',
      );
    }
  }
};
