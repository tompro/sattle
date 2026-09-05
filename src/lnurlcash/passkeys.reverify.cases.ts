import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { deriveWalletMaterial, saveWalletMaterial } from './keys';
import { registerPasskey, rewrapAllSlots, unlockWalletMaterialWithPasskey } from './passkeys';
import type { CeremonyCredential, PasskeyCredentials } from './passkeys';
import { stubLocalStorage } from './test-utils';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const MATERIAL = deriveWalletMaterial(MNEMONIC);
const OTHER_MATERIAL = deriveWalletMaterial(OTHER_MNEMONIC);
// same linking key (same owner) as MATERIAL, but a different, VALID cash root
const ALTERED_ROOT = { ...MATERIAL, cashRootHex: OTHER_MATERIAL.cashRootHex };
const SLOT_STORAGE_KEY = 'sattle_passkey_slots';
const MATERIAL_STORAGE_KEY = 'sattle_wallet_material_v2';

const toBytes = (source: BufferSource): Uint8Array =>
  source instanceof ArrayBuffer
    ? new Uint8Array(source)
    : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);

class FakeAuthenticator implements PasskeyCredentials {
  private readonly credentialId = new Uint8Array(16).fill(12);
  private readonly secret = new Uint8Array(32).fill(13);
  onCreate?: () => Promise<void>;
  onGet?: () => Promise<void>;

  create = async (options?: CredentialCreationOptions): Promise<CeremonyCredential> => {
    await this.onCreate?.();
    return this.credential(options?.publicKey?.extensions?.prf?.eval?.first);
  };

  get = async (options?: CredentialRequestOptions): Promise<CeremonyCredential | null> => {
    await this.onGet?.();
    const allowed = options?.publicKey?.allowCredentials ?? [];
    return allowed.some(
      (descriptor) => bytesToHex(toBytes(descriptor.id)) === bytesToHex(this.credentialId),
    )
      ? this.credential(options?.publicKey?.extensions?.prf?.eval?.first)
      : null;
  };

  private credential = (salt: BufferSource | undefined): CeremonyCredential => ({
    type: 'public-key',
    rawId: this.credentialId,
    getClientExtensionResults: () => ({
      prf: salt
        ? {
            enabled: true,
            results: { first: new Uint8Array(hmac(sha256, this.secret, toBytes(salt))) },
          }
        : {},
    }),
  });
}

const storageState = (): { slots: string | null; material: string | null } => ({
  slots: localStorage.getItem(SLOT_STORAGE_KEY),
  material: localStorage.getItem(MATERIAL_STORAGE_KEY),
});

beforeEach(() => {
  stubLocalStorage();
});

describe('passkey exact-material commitment re-verification', () => {
  it('rejects same-owner altered-root registration with byte-identical storage', async () => {
    const authenticator = new FakeAuthenticator();
    await saveWalletMaterial(MATERIAL);
    const before = storageState();

    await expect(registerPasskey(ALTERED_ROOT, { credentials: authenticator })).rejects.toThrow(
      'saved wallet material',
    );
    expect(storageState()).toEqual(before);
  });

  it('rejects same-owner altered-root registration against encrypted saved material', async () => {
    const authenticator = new FakeAuthenticator();
    await saveWalletMaterial(MATERIAL, 'password');
    const before = storageState();

    await expect(registerPasskey(ALTERED_ROOT, { credentials: authenticator })).rejects.toThrow(
      'saved wallet material',
    );
    expect(storageState()).toEqual(before);
  });

  it('writes nothing when same-owner saved material changes during registration', async () => {
    const authenticator = new FakeAuthenticator();
    await saveWalletMaterial(MATERIAL);
    let swapped: { slots: string | null; material: string | null } | null = null;
    authenticator.onCreate = async () => {
      await saveWalletMaterial(ALTERED_ROOT);
      swapped = storageState();
    };

    await expect(registerPasskey(MATERIAL, { credentials: authenticator })).rejects.toThrow(
      'saved wallet material',
    );
    expect(swapped).not.toBeNull();
    expect(storageState()).toEqual(swapped);
  });

  it('rejects unlock after same-owner saved replacement with byte-identical storage', async () => {
    const authenticator = new FakeAuthenticator();
    await saveWalletMaterial(MATERIAL);
    await registerPasskey(MATERIAL, { credentials: authenticator });
    await saveWalletMaterial(ALTERED_ROOT, 'password');
    const before = storageState();

    await expect(unlockWalletMaterialWithPasskey({ credentials: authenticator })).rejects.toThrow();
    expect(storageState()).toEqual(before);
  });

  it('writes nothing when same-owner saved material changes during the unlock ceremony', async () => {
    const authenticator = new FakeAuthenticator();
    await saveWalletMaterial(MATERIAL);
    await registerPasskey(MATERIAL, { credentials: authenticator });
    let swapped: { slots: string | null; material: string | null } | null = null;
    authenticator.onGet = async () => {
      await saveWalletMaterial(ALTERED_ROOT);
      swapped = storageState();
    };

    await expect(unlockWalletMaterialWithPasskey({ credentials: authenticator })).rejects.toThrow(
      'changed',
    );
    expect(swapped).not.toBeNull();
    expect(storageState()).toEqual(swapped);
  });

  it('rejects a same-owner altered-root re-wrap before changing any bytes', async () => {
    const authenticator = new FakeAuthenticator();
    await saveWalletMaterial(MATERIAL);
    const slot = await registerPasskey(MATERIAL, { credentials: authenticator });
    const before = storageState();

    await expect(
      rewrapAllSlots(ALTERED_ROOT, new Map([[slot.credentialId, new Uint8Array(32).fill(13)]])),
    ).rejects.toThrow('saved wallet material');
    expect(storageState()).toEqual(before);
  });

  it('returns the exact saved material on a committed unlock', async () => {
    const authenticator = new FakeAuthenticator();
    await saveWalletMaterial(MATERIAL);
    await registerPasskey(MATERIAL, { credentials: authenticator });
    const before = storageState();

    await expect(unlockWalletMaterialWithPasskey({ credentials: authenticator })).resolves.toEqual(
      MATERIAL,
    );
    expect(storageState()).toEqual(before);
  });
});
