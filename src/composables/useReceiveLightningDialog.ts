import { computed, ref, watch } from 'vue';
import { Notify } from 'quasar';

import { writeClipboard } from '@/capabilities/clipboard';
import { prepareMint, claimMintedNote } from '@/lnurlcash/ops';
import type { ClaimedNote, PreparedMint } from '@/lnurlcash/ops';
import type { NewBearer } from '@/lnurlcash/types';
import { msatToSats, satsToMsat, floorMsatToSat, MSAT_PER_SAT } from '@/lnurlcash/units';
import { mintAddressCacheInfo } from '@/lnurlcash/trustedMints';
import { TrustedMintPostCommitError, useWalletStore } from '@/stores/wallet';
import { useMintsStore } from '@/stores/mints';
import { useActivityStore } from '@/stores/activity';
import type { WalletOwnerFence } from '@/stores/walletOwnerFence';
import { useMintTrustPrompt } from './useMintTrustPrompt';

type ReceiveLightningProps = Readonly<{ modelValue: boolean }>;
type ReceiveLightningEmit = (event: 'received') => void;
type MintOption = Readonly<{ label: string; value: string }>;

export const useReceiveLightningDialog = (
  props: ReceiveLightningProps,
  emit: ReceiveLightningEmit,
) => {
  const wallet = useWalletStore();
  const mints = useMintsStore();
  const activity = useActivityStore();
  const CUSTOM_MINT = '__custom__';
  const displaySats = (msat: number): number => floorMsatToSat(msat) / MSAT_PER_SAT;
  const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : 'Something went wrong.';
  const step = ref<'form' | 'invoice' | 'success'>('form');
  const amountSats = ref<number | null>(null);
  const mintChoice = ref('');
  const customMint = ref('');
  const preparing = ref(false);
  const formError = ref('');
  const prepared = ref<PreparedMint | null>(null);
  const waiting = ref(false);
  const claimError = ref('');
  const receivedSats = ref(0);
  const receivedServer = ref('');
  const rotationWarning = ref('');
  const trustPrompt = useMintTrustPrompt();
  let claimRun: Promise<void> | null = null;
  const mintOptions = computed<MintOption[]>(() => {
    const options: MintOption[] = [];
    const seen = new Set<string>();
    for (const mint of mints.mints) {
      const address = mint.username ? `${mint.username}@${mint.server}` : `@${mint.server}`;
      if (seen.has(address)) continue;
      seen.add(address);
      options.push({
        label: mint.nodeAlias ? `${address} (${mint.nodeAlias})` : address,
        value: address,
      });
    }
    for (const publicMint of mints.PUBLIC_MINTS) {
      if (seen.has(publicMint)) continue;
      seen.add(publicMint);
      options.push({ label: publicMint, value: publicMint });
    }
    options.push({ label: 'Another mint…', value: CUSTOM_MINT });
    return options;
  });
  const defaultChoice = (): string => {
    const options = mintOptions.value;
    if (mints.defaultMint) {
      const match = options.find((option) => option.value.endsWith(`@${mints.defaultMint}`));
      if (match) return match.value;
    }
    const first = options[0];
    return first && first.value !== CUSTOM_MINT ? first.value : CUSTOM_MINT;
  };
  const formValid = computed(() => {
    if (!Number.isInteger(amountSats.value) || (amountSats.value ?? 0) < 1) return false;
    return mintChoice.value === CUSTOM_MINT
      ? customMint.value.trim() !== ''
      : mintChoice.value !== '';
  });
  const grossSats = computed(() => (prepared.value ? msatToSats(prepared.value.grossMsat) : 0));
  const netSats = computed(() =>
    prepared.value ? msatToSats(prepared.value.expectedNoteValueMsat) : 0,
  );
  const feeSats = computed(() => grossSats.value - netSats.value);
  const onClaimed = async (
    claimed: ClaimedNote,
    from: PreparedMint,
    ownerFence: WalletOwnerFence,
  ): Promise<void> => {
    const server = from.server;
    const wasTrusted = mints.isTrusted(server);
    const notes: NewBearer[] = claimed.possibleCopy
      ? [claimed.note, claimed.possibleCopy]
      : [claimed.note];
    let trustWarning = '';
    try {
      await wallet.addBearers(notes, ownerFence);
    } catch (error) {
      if (!(error instanceof TrustedMintPostCommitError)) throw error;
      trustWarning = error.message;
    }
    receivedSats.value = displaySats(claimed.note.amount);
    receivedServer.value = server;
    rotationWarning.value = claimed.rotationError ?? '';
    await activity.log(
      'mint',
      `Received ${receivedSats.value.toLocaleString()} sats from ${server} over Lightning.`,
      (error) => {
        trustWarning = error.message;
      },
    );
    const nodeInfo = mintAddressCacheInfo(from.nodeInfo, from.username);
    if (nodeInfo) {
      try {
        await mints.cacheNodeInfo(server, nodeInfo);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        trustWarning = `Funds were saved, but mint details could not be updated: ${errorMessage(error)}`;
      }
    }
    Notify.create({
      type: 'positive',
      message: `Received ${receivedSats.value.toLocaleString()} sats.`,
    });
    if (trustWarning) Notify.create({ type: 'warning', message: trustWarning });
    emit('received');
    if (props.modelValue) step.value = 'success';
    if (!wasTrusted && claimed.note.mintPubkey) {
      trustPrompt.openTrust(server, claimed.note.mintPubkey, from.nodeInfo?.nodeAlias ?? '');
    }
  };
  const beginClaim = (): void => {
    if (!prepared.value || claimRun) return;
    waiting.value = true;
    claimError.value = '';
    const current = prepared.value;
    claimRun = (async () => {
      try {
        const ownerFence = wallet.captureOwnerFence();
        await onClaimed(
          await claimMintedNote(current, {}, { assertOwner: ownerFence }),
          current,
          ownerFence,
        );
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        claimError.value = `${errorMessage(error)} The invoice stays valid — you can try again.`;
        Notify.create({ type: 'negative', message: errorMessage(error) });
      } finally {
        waiting.value = false;
      }
    })();
  };
  const createInvoice = async (): Promise<void> => {
    const sats = amountSats.value;
    if (!sats || preparing.value) return;
    preparing.value = true;
    formError.value = '';
    try {
      const input = mintChoice.value === CUSTOM_MINT ? customMint.value.trim() : mintChoice.value;
      const next = await prepareMint(input, satsToMsat(sats));
      if (!next.verifyUrl) {
        formError.value =
          'This mint does not support automatic claiming, so sattle cannot receive from it. Choose a different mint.';
        return;
      }
      prepared.value = next;
      claimRun = null;
      claimError.value = '';
      step.value = 'invoice';
      beginClaim();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      formError.value = errorMessage(error);
      Notify.create({ type: 'negative', message: formError.value });
    } finally {
      preparing.value = false;
    }
  };
  const copyInvoice = async (): Promise<void> => {
    if (!prepared.value) return;
    try {
      await writeClipboard(prepared.value.invoice);
      Notify.create({ type: 'positive', message: 'Invoice copied.' });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      Notify.create({ type: 'negative', message: errorMessage(error) });
    }
  };
  const retryClaim = (): void => {
    claimRun = null;
    beginClaim();
  };
  const stopWaiting = (): void => {
    waiting.value = false;
  };
  const resumeWaiting = (): void => {
    if (claimRun) waiting.value = true;
  };
  watch(
    () => props.modelValue,
    (open) => {
      if (!open) return;
      step.value = 'form';
      amountSats.value = null;
      customMint.value = '';
      mintChoice.value = defaultChoice();
      preparing.value = false;
      formError.value = '';
      prepared.value = null;
      waiting.value = false;
      rotationWarning.value = '';
    },
  );
  return {
    CUSTOM_MINT,
    amountSats,
    claimError,
    copyInvoice,
    createInvoice,
    customMint,
    feeSats,
    formError,
    formValid,
    grossSats,
    mintChoice,
    mintOptions,
    netSats,
    prepared,
    preparing,
    receivedSats,
    receivedServer,
    resumeWaiting,
    retryClaim,
    rotationWarning,
    showTrust: trustPrompt.showTrust,
    skipTrust: trustPrompt.skipTrust,
    step,
    stopWaiting,
    trustMint: trustPrompt.trustMint,
    trustNodeAlias: trustPrompt.trustNodeAlias,
    trustServer: trustPrompt.trustServer,
    waiting,
  };
};
