import { PASSWORD, mocks } from './wallet.lifecycle.testHarness';
import { afterEach, beforeEach, describe, expect, vi, it } from 'vitest';

import { useNwcStore } from './nwc';
import { useWalletStore } from './wallet';

const AUTO_LOCK_MS = 5 * 60 * 1000;

describe('idle auto-lock failure', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears runtime keys and surfaces the error when an idle auto-lock drain fails', async () => {
    // Given an encrypted unlocked wallet whose live NWC service rejects shutdown
    const wallet = useWalletStore();
    const nwc = useNwcStore();
    await wallet.create(PASSWORD);
    const serviceStop = vi.fn().mockRejectedValue(new Error('idle drain failed'));
    mocks.startService.mockResolvedValue({ connections: [], stop: serviceStop });
    await nwc.setEnabled(true);
    expect(nwc.running).toBe(true);
    expect(wallet.state).toBe('unlocked');

    // When the wallet goes idle past the auto-lock timeout
    await vi.advanceTimersByTimeAsync(AUTO_LOCK_MS + 2000);

    // Then the rejected drain still leaves a truthful locked state: no usable
    // key material, the failure surfaced, the service handle dropped
    expect(wallet.state).toBe('locked');
    expect(wallet.lifecycleError).toMatch(/idle drain failed/i);
    expect(() => wallet.requireLinkingKey()).toThrow('Wallet is locked.');
    expect(wallet.bearers).toEqual([]);
    expect(nwc.running).toBe(false);
    expect(serviceStop).toHaveBeenCalledTimes(1);
  });
});
