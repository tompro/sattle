import { MINT_KEY, PASSWORD, deferred, mocks } from './wallet.lifecycle.testHarness';
import { describe, expect, it, vi } from 'vitest';

import { savedKeyExists } from '@/lnurlcash/keys';
import { addTrustedMint } from '@/lnurlcash/trustedMints';
import { useNwcStore } from './nwc';
import { useWalletStore } from './wallet';

describe('complete owner teardown', () => {
  it('clears runtime keys and the NWC service when ordinary lock drain fails', async () => {
    // Given an encrypted unlocked wallet whose live NWC service rejects shutdown
    const serviceStop = vi.fn().mockRejectedValue(new Error('NWC lock drain failed'));
    mocks.startService.mockResolvedValue({ connections: [], stop: serviceStop });
    const wallet = useWalletStore();
    const nwc = useNwcStore();
    await wallet.create(PASSWORD);
    await nwc.setEnabled(true);
    expect(nwc.running).toBe(true);

    // When ordinary lock invalidates the session and shutdown rejects
    const locking = wallet.lock();

    // Then failure is truthful while no runtime capability remains usable
    await expect(locking).rejects.toThrow('NWC lock drain failed');
    expect(wallet.state).toBe('locked');
    expect(wallet.lifecycleError).toMatch(/NWC lock drain failed/i);
    expect(() => wallet.requireLinkingKey()).toThrow('Wallet is locked.');
    expect(wallet.bearers).toEqual([]);
    expect(nwc.running).toBe(false);
    expect(serviceStop).toHaveBeenCalledTimes(1);
  });

  it('waits for NWC drain and removes owner state plus idle listeners before none', async () => {
    // Given an encrypted wallet with owner data and tracked window listeners
    const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
    const cleanupOrder: string[] = [];
    vi.stubGlobal('window', {
      addEventListener: (event: string, listener: EventListenerOrEventListenerObject) => {
        const registered = listeners.get(event) ?? new Set();
        registered.add(listener);
        listeners.set(event, registered);
      },
      removeEventListener: (event: string, listener: EventListenerOrEventListenerObject) => {
        cleanupOrder.push(`listener:${event}`);
        listeners.get(event)?.delete(listener);
      },
    });
    const wallet = useWalletStore();
    const nwc = useNwcStore();
    await wallet.create(PASSWORD);
    const ownerId = wallet.pubkey;
    if (ownerId === null) throw new Error('Expected an unlocked owner.');
    await addTrustedMint('owned.example', MINT_KEY, { ownerId });
    localStorage.setItem(
      'sattle_passkey_slots',
      JSON.stringify([
        {
          credentialId: '11'.repeat(16),
          hkdfSalt: '22'.repeat(16),
          iv: '33'.repeat(12),
          wrappedKey: '44'.repeat(48),
          createdAt: 1,
          ownerId,
        },
      ]),
    );
    const drain = deferred();
    const stopSpy = vi.spyOn(nwc, 'stop').mockReturnValue(drain.promise);
    const removeItem = localStorage.removeItem.bind(localStorage);
    localStorage.removeItem = (key: string): void => {
      cleanupOrder.push(`storage:${key}`);
      removeItem(key);
    };

    // When forget starts while NWC work is still draining
    const forgetting = wallet.forgetWallet();
    await vi.waitFor(() => expect(stopSpy).toHaveBeenCalled());

    // Then completion and destructive storage removal wait for the drain,
    // and the session stays commit-capable (fence and keys live) until it
    // finishes so accepted NWC work can still reach its durable outcome
    expect(savedKeyExists()).toBe(true);
    expect(wallet.state).toBe('unlocked');
    drain.resolve();
    await forgetting;
    expect(wallet.state).toBe('none');
    expect(savedKeyExists()).toBe(false);
    expect(localStorage.getItem('sattle_passkey_slots')).toBeNull();
    expect(localStorage.getItem('sattle_nwc_connections')).toBeNull();
    expect(localStorage.getItem('sattle_nwc_enabled')).toBeNull();
    expect(localStorage.getItem('sattle_trusted_mints')).toBeNull();
    expect([...listeners.values()].every((registered) => registered.size === 0)).toBe(true);
    expect(cleanupOrder.indexOf('listener:scroll')).toBeLessThan(
      cleanupOrder.indexOf('storage:sattle_linking_key'),
    );
  });

  it('surfaces biometric deletion failure without reporting completion', async () => {
    // Given an unlocked wallet whose secure-storage deletion rejects
    const wallet = useWalletStore();
    useNwcStore();
    await wallet.create(PASSWORD);
    mocks.disableBiometricUnlock.mockRejectedValue(new Error('secure delete failed'));

    // When forget reaches biometric teardown
    const forgetting = wallet.forgetWallet();

    // Then the caller sees failure and the saved key is not falsely removed
    await expect(forgetting).rejects.toThrow('secure delete failed');
    expect(wallet.state).toBe('locked');
    expect(wallet.lifecycleError).toMatch(/secure delete failed/i);
    expect(savedKeyExists()).toBe(true);
    expect(() => wallet.requireLinkingKey()).toThrow('Wallet is locked.');
  });

  it('surfaces NWC drain failure without removing the saved owner', async () => {
    // Given an unlocked wallet whose service drain rejects
    const wallet = useWalletStore();
    const nwc = useNwcStore();
    await wallet.create(PASSWORD);
    vi.spyOn(nwc, 'stop').mockRejectedValue(new Error('NWC drain failed'));

    // When forget invalidates the session and requests the drain
    const forgetting = wallet.forgetWallet();

    // Then teardown rejects before deleting owner storage or reporting none
    await expect(forgetting).rejects.toThrow('NWC drain failed');
    expect(wallet.state).toBe('locked');
    expect(wallet.lifecycleError).toMatch(/NWC drain failed/i);
    expect(savedKeyExists()).toBe(true);
    expect(() => wallet.requireLinkingKey()).toThrow('Wallet is locked.');
  });

  it('completes teardown on retry after a transient biometric deletion failure', async () => {
    // Given a forget that failed at secure-storage deletion
    const wallet = useWalletStore();
    useNwcStore();
    await wallet.create(PASSWORD);
    mocks.disableBiometricUnlock.mockRejectedValueOnce(new Error('secure delete failed'));
    await expect(wallet.forgetWallet()).rejects.toThrow('secure delete failed');
    expect(wallet.state).toBe('locked');

    // When the holder retries the forget
    await wallet.forgetWallet();

    // Then teardown completes and the error surface clears
    expect(wallet.state).toBe('none');
    expect(wallet.lifecycleError).toBe('');
    expect(savedKeyExists()).toBe(false);
  });
});
