import { MINT_KEY, OTHER_OWNER_ID, PASSWORD } from './wallet.lifecycle.testHarness';
import { describe, expect, it, vi } from 'vitest';

import { savedKeyOwnerId } from '@/lnurlcash/keys';
import { readNwcEnabled, writeNwcConnections, writeNwcEnabled } from '@/lnurlcash/nwc';
import type { NwcConnectionRecord } from '@/lnurlcash/nwc';
import { addTrustedMint, readTrustedMints } from '@/lnurlcash/trustedMints';
import { useWalletStore } from './wallet';

describe('cross-tab owner invalidation', () => {
  it('locks an old tab and rejects trust or NWC writes after replacement', async () => {
    // Given an unlocked old-owner tab listening for browser storage events
    const events = new EventTarget();
    vi.stubGlobal('window', events);
    const wallet = useWalletStore();
    await wallet.create(PASSWORD);
    const oldOwner = wallet.pubkey;
    if (oldOwner === null) throw new Error('Expected an unlocked old owner.');

    // When another tab has already recreated the wallet and a delayed event arrives
    localStorage.setItem(
      'sattle_linking_key',
      JSON.stringify({ enc: false, value: '09'.repeat(32), ownerId: OTHER_OWNER_ID, version: 1 }),
    );
    events.dispatchEvent(
      Object.defineProperties(new Event('storage'), {
        key: { value: 'sattle_linking_key' },
        newValue: { value: JSON.stringify({ ownerId: oldOwner }) },
      }),
    );
    await vi.waitFor(() => expect(wallet.state).toBe('locked'));

    // Then the stale runtime has no usable key and cannot recreate old-owner state
    expect(() => wallet.requireLinkingKey()).toThrow('Wallet is locked.');
    await expect(addTrustedMint('stale.example', MINT_KEY, { ownerId: oldOwner })).rejects.toThrow(
      /owner/i,
    );
    expect(localStorage.getItem('sattle_trusted_mints')).toBeNull();
    writeNwcEnabled(OTHER_OWNER_ID, false);
    expect(() => writeNwcEnabled(oldOwner, true)).toThrow(/owner/i);
    expect(readNwcEnabled(OTHER_OWNER_ID)).toBe(false);
  });

  it('rejects old-owner trust and NWC writes during the markerless forget gap', async () => {
    // Given wallet A was active and an old tab retained only its owner identifier
    const wallet = useWalletStore();
    await wallet.create(PASSWORD);
    const oldOwner = wallet.pubkey;
    if (oldOwner === null) throw new Error('Expected an unlocked old owner.');
    const staleConnection: NwcConnectionRecord = {
      version: 1,
      ownerId: oldOwner,
      clientPubkey: '55'.repeat(32),
      relays: ['wss://relay.example'],
      budget: { maxMsat: 1000, periodMs: 60_000 },
      spent: { periodStart: 0, msat: 0 },
      createdAt: 1,
    };

    // When A is forgotten before successor B is installed
    await wallet.forgetWallet();
    expect(savedKeyOwnerId()).toBeNull();

    // Then no stale normal mutation can recreate A-owned state in the gap
    await expect(
      addTrustedMint('stale-gap.example', MINT_KEY, { ownerId: oldOwner }),
    ).rejects.toThrow(/owner/i);
    expect(() => writeNwcConnections(oldOwner, [staleConnection])).toThrow(/owner/i);
    expect(() => writeNwcEnabled(oldOwner, true)).toThrow(/owner/i);
    expect(localStorage.getItem('sattle_trusted_mints')).toBeNull();
    expect(localStorage.getItem('sattle_nwc_connections')).toBeNull();
    expect(localStorage.getItem('sattle_nwc_enabled')).toBeNull();

    // When B is later installed
    await wallet.create(PASSWORD);
    const successorOwner = wallet.pubkey;
    if (successorOwner === null) throw new Error('Expected an unlocked successor owner.');

    // Then B starts clean and can create its own independent trust registry
    await expect(
      addTrustedMint('successor-gap.example', MINT_KEY, { ownerId: successorOwner }),
    ).resolves.toBe('added');
    expect(readTrustedMints(successorOwner).map((mint) => mint.server)).toEqual([
      'successor-gap.example',
    ]);
  });
});
