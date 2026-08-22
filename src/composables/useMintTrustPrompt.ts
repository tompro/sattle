import { ref } from 'vue';
import { Notify } from 'quasar';
import { useMintsStore } from '@/stores/mints';

export const useMintTrustPrompt = () => {
  const mints = useMintsStore();
  const showTrust = ref(false);
  const trustServer = ref('');
  const trustPubkey = ref('');
  const trustNodeAlias = ref('');
  const openTrust = (server: string, pubkey: string, nodeAlias = ''): void => {
    trustServer.value = server;
    trustPubkey.value = pubkey;
    trustNodeAlias.value = nodeAlias;
    showTrust.value = true;
  };
  const trustMint = async (): Promise<void> => {
    try {
      await mints.trust(trustServer.value, trustPubkey.value, {
        ...(trustNodeAlias.value ? { nodeAlias: trustNodeAlias.value } : {}),
      });
      Notify.create({ type: 'positive', message: 'Mint trusted.' });
    } catch (error) {
      const caught = error instanceof Error ? error : new Error(String(error));
      Notify.create({ type: 'negative', message: caught.message });
    } finally {
      showTrust.value = false;
    }
  };
  const skipTrust = (): void => {
    showTrust.value = false;
    Notify.create({
      type: 'warning',
      message:
        'Note added, but this mint is not in your trusted list yet — you can review it in Settings.',
    });
  };
  return {
    openTrust,
    showTrust,
    skipTrust,
    trustMint,
    trustNodeAlias,
    trustServer,
  };
};
