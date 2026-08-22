import {
  OWNER_ID,
  PASSWORD,
  deferred,
  installLegacyEncryptedWallet,
  installLegacyOwnerlessResidue,
  mocks,
} from './wallet.lifecycle.testHarness';
import { describe, expect, it, vi } from 'vitest';

import { savedKeyExists, savedKeyOwnerId } from '@/lnurlcash/keys';
import { readNwcConnections } from '@/lnurlcash/nwc';
import { readPasskeySlots } from '@/lnurlcash/passkeys';
import { readTrustedMints } from '@/lnurlcash/trustedMints';
import { useNwcStore } from './nwc';
import { useWalletStore } from './wallet';

describe('serialized wallet activation', () => {
  it('migrates a proven legacy owner before NWC can observe unlocked', async () => {
    // Given an encrypted legacy wallet with ownerless authorization residue
    await installLegacyEncryptedWallet();
    installLegacyOwnerlessResidue();
    const wallet = useWalletStore();
    useNwcStore();

    // When password proof unlocks the wallet
    await wallet.unlock(PASSWORD);

    // Then every legacy namespace belongs to the proven owner before startup
    expect(savedKeyOwnerId()).toBe(OWNER_ID);
    expect(readPasskeySlots()).toHaveLength(1);
    expect(readNwcConnections(OWNER_ID)).toHaveLength(1);
    expect(readTrustedMints(OWNER_ID)).toHaveLength(1);
    expect(wallet.state).toBe('unlocked');
    await vi.waitFor(() => expect(mocks.startService).toHaveBeenCalledTimes(1));
  });

  it('serializes a queued create behind an interrupted forget', async () => {
    // Given an unlocked wallet whose NWC drain is deferred
    const wallet = useWalletStore();
    const nwc = useNwcStore();
    await wallet.create(PASSWORD);
    const drain = deferred();
    const stopSpy = vi.spyOn(nwc, 'stop').mockReturnValue(drain.promise);

    // When forget and create are requested without waiting between them
    const forgetting = wallet.forgetWallet();
    const creating = wallet.create();
    await vi.waitFor(() => expect(stopSpy).toHaveBeenCalled());

    // Then the successor cannot install until the old owner drain completes,
    // and the session keeps its commit capability while the drain runs
    expect(savedKeyExists()).toBe(true);
    expect(wallet.state).toBe('unlocked');
    drain.resolve();
    await forgetting;
    const phrase = await creating;
    expect(phrase.split(' ')).toHaveLength(12);
    expect(wallet.state).toBe('unlocked');
  });

  it('drains the active session before file restore reactivation', async () => {
    // Given an unlocked wallet whose NWC drain is deferred
    const wallet = useWalletStore();
    const nwc = useNwcStore();
    await wallet.create(PASSWORD);
    const drain = deferred();
    const stopSpy = vi.spyOn(nwc, 'stop').mockReturnValue(drain.promise);

    // When a valid file restore starts
    const restoring = wallet.restoreFromBackup({
      type: 'sattle-backup',
      version: 1,
      createdAt: 1,
      bearers: [],
    });
    await vi.waitFor(() => expect(stopSpy).toHaveBeenCalled());

    // Then deactivation waits for the drain before the lifecycle is
    // invalidated, and reactivation returns to unlocked afterward
    expect(wallet.state).toBe('unlocked');
    drain.resolve();
    await restoring;
    expect(wallet.state).toBe('unlocked');
  });

  it('serializes current-wallet Nostr restore through full reactivation', async () => {
    // Given an unlocked wallet and a relay restore result
    const wallet = useWalletStore();
    useNwcStore();
    await wallet.create(PASSWORD);
    const ownerId = wallet.pubkey;

    // When the active-wallet Nostr restore runs
    await wallet.restoreCurrentFromNostr(['wss://relay.example']);

    // Then the same owner is active only after the restore completed
    expect(mocks.restoreFromNostr).toHaveBeenCalledTimes(1);
    expect(wallet.state).toBe('unlocked');
    expect(wallet.pubkey).toBe(ownerId);
  });
});
