import {
  LEGACY_LINKING_KEY,
  MATERIAL,
  MINT_KEY,
  OTHER_MATERIAL,
  PASSWORD,
  WALLET_MATERIAL_KEY,
  deferredLocks,
  installEncryptedWalletMaterial,
  installLegacyOwnerlessResidue,
  installOwnerlessEncryptedWalletMaterial,
  mocks,
} from './wallet.lifecycle.testHarness';
import { describe, expect, it, vi } from 'vitest';
import { buildNoteUrl } from 'lnurlcash-kit';

import {
  deriveBearerAesKey,
  encryptRecord,
  saveWalletMaterial,
  savedWalletMaterialExists,
  savedWalletMaterialHash,
  savedWalletMaterialOwnerId,
  walletMaterialHash,
  walletMaterialLinkingKey,
} from '@/lnurlcash/keys';
import { FUNDS_STORAGE_KEY } from '@/lnurlcash/storage/bearers';
import { useWalletStore } from './wallet';

describe('complete material activation', () => {
  it('persists v2 material on create and activates the same value on every unlock factor', async () => {
    // Given a wallet created through the lifecycle
    const wallet = useWalletStore();
    const phrase = await wallet.create(PASSWORD);
    expect(phrase.split(' ')).toHaveLength(12);

    // Then the v2 envelope is the only saved secret record
    expect(savedWalletMaterialExists()).toBe(true);
    expect(localStorage.getItem(LEGACY_LINKING_KEY)).toBeNull();
    const active = wallet.requireWalletMaterial();
    expect(savedWalletMaterialHash()).toBe(walletMaterialHash(active));
    expect(wallet.state).toBe('unlocked');

    // When the wallet is unlocked through each factor in turn
    await wallet.lock();
    expect(() => wallet.requireWalletMaterial()).toThrow('Wallet is locked.');
    await wallet.unlock(PASSWORD);
    expect(wallet.requireWalletMaterial()).toEqual(active);

    await wallet.lock();
    mocks.unlockWalletMaterialWithPasskey.mockResolvedValue(active);
    await wallet.unlockWithPasskey();
    expect(wallet.requireWalletMaterial()).toEqual(active);

    await wallet.lock();
    mocks.unlockWalletMaterialWithBiometrics.mockResolvedValue(active);
    await wallet.unlockWithBiometric();

    // Then every factor activated the exact same complete material
    expect(wallet.requireWalletMaterial()).toEqual(active);
    expect(wallet.state).toBe('unlocked');
  });

  it('keeps the material private and memory-only while unlocked', async () => {
    // Given an encrypted wallet
    const wallet = useWalletStore();
    await wallet.create(PASSWORD);

    // Then the persisted record holds only the wrap, never plaintext material
    const stored = JSON.parse(localStorage.getItem(WALLET_MATERIAL_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(stored.enc).toBe(true);
    expect(stored.value).toBeUndefined();

    // And locking drops every runtime reference to it
    await wallet.lock();
    expect(() => wallet.requireWalletMaterial()).toThrow('Wallet is locked.');
    expect(() => wallet.requireLinkingKey()).toThrow('Wallet is locked.');
    expect(wallet.state).toBe('locked');
  });

  it('fences activation when the saved owner is replaced during deferred loading', async () => {
    // Given a restored (ownerless) wallet whose activation pauses inside the
    // legacy-adoption storage lock
    await installOwnerlessEncryptedWalletMaterial();
    installLegacyOwnerlessResidue();
    const deferred = deferredLocks();
    vi.stubGlobal('navigator', { locks: deferred.locks });
    const wallet = useWalletStore();

    // When the saved material is replaced by a different owner mid-activation
    const unlocking = wallet.unlock(PASSWORD);
    await vi.waitFor(() => expect(deferred.requests).toHaveLength(1));
    await saveWalletMaterial(OTHER_MATERIAL);
    await deferred.releaseNext();

    // Then activation rejects, no runtime material survives, and the
    // replacement's locked record is what remains
    await expect(unlocking).rejects.toThrow();
    expect(wallet.state).toBe('locked');
    expect(savedWalletMaterialOwnerId()).not.toBeNull();
    expect(wallet.pubkey).toBeNull();
    expect(() => wallet.requireWalletMaterial()).toThrow('Wallet is locked.');
    expect(wallet.bearers).toEqual([]);
  });

  it('fences activation on a final pre-unlocked owner re-read after deferred trust work', async () => {
    // Given an owned wallet holding a mint-pinned bearer whose trust
    // restoration pauses inside the trusted-mints storage lock
    await installEncryptedWalletMaterial();
    const aesKey = await deriveBearerAesKey(walletMaterialLinkingKey(MATERIAL));
    const bearer = {
      url: buildNoteUrl('https://mint.example/w', 'bb'.repeat(32), 21_000),
      callback: 'https://mint.example/w/cb',
      amount: 21_000,
      verified: true,
      mintPubkey: MINT_KEY,
      createdAt: 1,
      updatedAt: 1,
    };
    const record = await encryptRecord(aesKey, bearer);
    localStorage.setItem(
      FUNDS_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        bearers: [{ id: 'b1', ...record }],
        pending: [],
        nextByHost: {},
        revision: 0,
      }),
    );
    const deferred = deferredLocks();
    vi.stubGlobal('navigator', { locks: deferred.locks });
    const wallet = useWalletStore();

    // When the saved owner is replaced while trust restoration is suspended
    const unlocking = wallet.unlock(PASSWORD);
    await vi.waitFor(() => expect(deferred.requests).toHaveLength(1));
    await saveWalletMaterial(OTHER_MATERIAL);
    await deferred.releaseNext();

    // Then the pre-unlocked re-read rejects the stale activation before the
    // wallet ever exposes an unlocked state
    await expect(unlocking).rejects.toThrow();
    expect(wallet.state).toBe('locked');
    expect(wallet.pubkey).toBeNull();
    expect(() => wallet.requireWalletMaterial()).toThrow('Wallet is locked.');
    expect(wallet.bearers).toEqual([]);
  });

  it('leaves no half-installed wallet when the material write fails during create', async () => {
    // Given a store whose material write hits a full disk
    const wallet = useWalletStore();
    const setItem = localStorage.setItem.bind(localStorage);
    localStorage.setItem = (key: string, value: string): void => {
      if (key === WALLET_MATERIAL_KEY) throw new Error('quota exceeded');
      setItem(key, value);
    };

    // When create cannot persist the complete material
    await expect(wallet.create(PASSWORD)).rejects.toThrow(/quota exceeded/);

    // Then nothing is installed and no runtime material lingers
    expect(wallet.state).toBe('none');
    expect(savedWalletMaterialExists()).toBe(false);
    expect(() => wallet.requireWalletMaterial()).toThrow('Wallet is locked.');

    // And the transition is retryable once storage works again
    localStorage.setItem = setItem;
    const phrase = await wallet.create(PASSWORD);
    expect(phrase.split(' ')).toHaveLength(12);
    expect(wallet.state).toBe('unlocked');
  });

  it('rejects unlock without saved material and stays at none', async () => {
    // Given no wallet on this device
    const wallet = useWalletStore();

    // When an unlock is attempted anyway
    await expect(wallet.unlock(PASSWORD)).rejects.toThrow();

    // Then the device stays uninstalled and retryable
    expect(wallet.state).toBe('none');
    expect(() => wallet.requireWalletMaterial()).toThrow('Wallet is locked.');
  });
});
