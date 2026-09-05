import {
  LEGACY_BEARERS_KEY,
  LEGACY_LINKING_KEY,
  MATERIAL,
  OWNER_ID,
  WALLET_MATERIAL_KEY,
  installLegacyOwnerlessResidue,
  installLegacyWalletState,
  mocks,
} from './wallet.lifecycle.testHarness';
import { describe, expect, it } from 'vitest';

import { saveWalletMaterial, savedWalletMaterialExists } from '@/lnurlcash/keys';
import { useWalletStore } from './wallet';

describe('unsupported legacy install reset', () => {
  it('resets legacy saved-key and bearer state before routing', async () => {
    // Given an alpha install: the linking-key-only record, the legacy bearer
    // namespace, and ownerless authorization residue
    installLegacyWalletState();
    installLegacyOwnerlessResidue();

    // When the store is constructed, it must not advertise the legacy wallet
    const wallet = useWalletStore();
    expect(wallet.state).toBe('none');

    // When startup initialization runs
    await wallet.init();

    // Then every legacy namespace is gone and nothing was activated
    expect(localStorage.getItem(LEGACY_LINKING_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_BEARERS_KEY)).toBeNull();
    expect(localStorage.getItem('sattle_passkey_slots')).toBeNull();
    expect(localStorage.getItem('sattle_nwc_connections')).toBeNull();
    expect(localStorage.getItem('sattle_nwc_enabled')).toBeNull();
    expect(localStorage.getItem('sattle_trusted_mints')).toBeNull();
    expect(localStorage.getItem(WALLET_MATERIAL_KEY)).toBeNull();
    expect(wallet.state).toBe('none');
    expect(mocks.disableBiometricUnlock).toHaveBeenCalledTimes(1);
  });

  it('resets on a corrupt legacy record without parsing it', async () => {
    // Given a legacy entry that no parser can read
    localStorage.setItem(LEGACY_LINKING_KEY, '{{{not json');
    const wallet = useWalletStore();
    expect(wallet.state).toBe('none');

    // When startup initialization runs
    await wallet.init();

    // Then the reset keyed on raw presence, not on a successful parse
    expect(localStorage.getItem(LEGACY_LINKING_KEY)).toBeNull();
    expect(wallet.state).toBe('none');
  });

  it('keeps a v2 install and only removes stray legacy key residue', async () => {
    // Given a current plaintext v2 wallet plus a stray legacy record (an old
    // tab or a restored backup left it behind)
    await saveWalletMaterial(MATERIAL);
    localStorage.setItem(
      LEGACY_LINKING_KEY,
      JSON.stringify({ enc: false, value: '09'.repeat(32), ownerId: 'ab'.repeat(33), version: 1 }),
    );
    const wallet = useWalletStore();
    expect(wallet.state).toBe('locked');

    // When startup initialization runs
    await wallet.init();

    // Then the v2 wallet activated and only the legacy residue is gone
    expect(wallet.state).toBe('unlocked');
    expect(wallet.pubkey).toBe(OWNER_ID);
    expect(localStorage.getItem(LEGACY_LINKING_KEY)).toBeNull();
    expect(savedWalletMaterialExists()).toBe(true);
  });

  it('leaves legacy state intact and retryable when native biometric deletion fails', async () => {
    // Given an alpha install whose secure-storage deletion rejects
    installLegacyWalletState();
    const wallet = useWalletStore();
    mocks.disableBiometricUnlock.mockRejectedValueOnce(new Error('secure delete failed'));

    // When startup initialization runs
    await wallet.init();

    // Then the failure is surfaced, nothing was half-wiped, and the legacy
    // state is still all there for the next attempt
    expect(wallet.lifecycleError).toMatch(/secure delete failed/i);
    expect(wallet.state).toBe('none');
    expect(localStorage.getItem(LEGACY_LINKING_KEY)).not.toBeNull();
    expect(localStorage.getItem(LEGACY_BEARERS_KEY)).not.toBeNull();

    // When initialization runs again with native deletion succeeding
    await wallet.init();

    // Then the reset completes
    expect(wallet.lifecycleError).toBe('');
    expect(localStorage.getItem(LEGACY_LINKING_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_BEARERS_KEY)).toBeNull();
  });

  it('retries the legacy reset before installing a successor wallet', async () => {
    // Given an alpha install whose first reset attempt failed at native
    // biometric deletion
    installLegacyWalletState();
    const wallet = useWalletStore();
    mocks.disableBiometricUnlock.mockRejectedValueOnce(new Error('secure delete failed'));
    await wallet.init();
    expect(localStorage.getItem(LEGACY_LINKING_KEY)).not.toBeNull();

    // When the holder installs a fresh wallet
    const phrase = await wallet.create();

    // Then the pending reset ran first: no legacy residue survives into the
    // successor installation
    expect(phrase.split(' ')).toHaveLength(12);
    expect(localStorage.getItem(LEGACY_LINKING_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_BEARERS_KEY)).toBeNull();
    expect(wallet.state).toBe('unlocked');
    expect(savedWalletMaterialExists()).toBe(true);
  });
});
