import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import {
  fetchMintAddress,
  fetchPayRequest,
  lightningAddressUsername,
  mintAddressUrl,
  resolveMintInput,
  serverOf,
} from 'lnurlcash-kit';

import { mintAddressCacheInfo } from '@/lnurlcash/trustedMints';
import { useMintsStore } from '@/stores/mints';
import { useWalletStore } from '@/stores/wallet';

export const useManageMintsPage = () => {
  const router = useRouter();
  const $q = useQuasar();
  const mints = useMintsStore();
  const wallet = useWalletStore();
  const toast = (type: 'positive' | 'negative' | 'warning' | 'info', message: string): void => {
    if (typeof $q.notify === 'function') {
      $q.notify({ type, message, position: 'top', timeout: 3000 });
    }
  };
  const fingerprint = (pubkey: string): string =>
    pubkey.length > 18 ? `${pubkey.slice(0, 10)}…${pubkey.slice(-8)}` : pubkey;
  const balanceAt = (server: string): string =>
    (wallet.balanceByMintSats.get(server) ?? 0).toLocaleString(undefined, {
      maximumFractionDigits: 3,
    });
  const suggestions = computed(() =>
    mints.PUBLIC_MINTS.filter(
      (address) => !mints.mints.some((mint) => mint.server === address.replace(/^@/, '')),
    ),
  );
  const banner = ref('');
  const addServer = ref('');
  const addPubkey = ref('');
  const discovering = ref('');
  const confirmingRemove = ref(false);
  const removeTarget = ref('');
  const trustResult = (result: string, server: string): void => {
    if (result === 'rekey-pending') {
      toast('warning', `${server} advertised a different signing key - review it above.`);
    } else if (result === 'unchanged') {
      toast('info', `${server} is already trusted.`);
    } else {
      toast('positive', `${server} is now trusted.`);
    }
  };
  const trustManual = async (): Promise<void> => {
    banner.value = '';
    try {
      const result = await mints.trust(addServer.value, addPubkey.value);
      trustResult(result, addServer.value.trim());
      addServer.value = '';
      addPubkey.value = '';
    } catch (error) {
      banner.value = error instanceof Error ? error.message : 'Could not trust that mint.';
    }
  };
  const trustSuggestion = async (address: string): Promise<void> => {
    if (discovering.value) return;
    banner.value = '';
    discovering.value = address;
    try {
      const url = resolveMintInput(address);
      if (!url) throw new Error('That mint address cannot be resolved.');
      let nodeInfo = null;
      let payUrl = url;
      const addressUrl = mintAddressUrl(url);
      if (addressUrl) {
        try {
          nodeInfo = await fetchMintAddress(addressUrl);
          payUrl = nodeInfo.payLink;
        } catch (error) {
          if (!(error instanceof Error)) throw error;
        }
      }
      const info = await fetchPayRequest(payUrl);
      const announcedKey = nodeInfo?.nodePubkey ?? info.mintPubkey;
      if (!announcedKey) {
        throw new Error("This mint didn't announce its signing key - add it manually instead.");
      }
      const server = serverOf(payUrl);
      const result = await mints.trust(
        server,
        announcedKey,
        mintAddressCacheInfo(nodeInfo, lightningAddressUsername(payUrl)),
      );
      trustResult(result, server);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not reach that mint.';
      banner.value = `Could not add ${address}: ${message}`;
    } finally {
      discovering.value = '';
    }
  };
  const askRemove = (server: string): void => {
    banner.value = '';
    removeTarget.value = server;
    confirmingRemove.value = true;
  };
  const doRemove = async (): Promise<void> => {
    confirmingRemove.value = false;
    try {
      await mints.remove(removeTarget.value);
      if (mints.defaultMint === removeTarget.value) mints.setDefaultMint(null);
      toast('positive', `${removeTarget.value} removed.`);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      banner.value = `${removeTarget.value} can't be removed while you hold notes from it - move or spend them first.`;
    }
  };
  const confirmRekey = async (server: string): Promise<void> => {
    banner.value = '';
    try {
      await mints.confirmRekey(server);
    } catch (error) {
      banner.value = error instanceof Error ? error.message : 'Could not confirm that signing key.';
    }
  };
  const dismissRekey = async (server: string): Promise<void> => {
    banner.value = '';
    try {
      await mints.dismissRekey(server);
    } catch (error) {
      banner.value = error instanceof Error ? error.message : 'Could not dismiss that signing key.';
    }
  };
  return {
    addPubkey,
    addServer,
    askRemove,
    balanceAt,
    banner,
    confirmingRemove,
    confirmRekey,
    discovering,
    dismissRekey,
    doRemove,
    fingerprint,
    mints,
    removeTarget,
    router,
    suggestions,
    trustManual,
    trustSuggestion,
  };
};
