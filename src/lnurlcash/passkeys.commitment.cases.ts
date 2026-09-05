import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { deriveWalletMaterial, saveWalletMaterial } from './keys';
import {
  getPasskeyPrfOutput,
  registerPasskey,
  rewrapAllSlots,
  unlockWalletMaterialWithPasskey,
} from './passkeys';
import type { CeremonyCredential, PasskeyCredentials } from './passkeys';
import { stubLocalStorage } from './test-utils';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const MATERIAL = { ...deriveWalletMaterial(MNEMONIC), linkingKeyHex: '07'.repeat(32) };
const OTHER_MATERIAL = deriveWalletMaterial(OTHER_MNEMONIC);
const ALTERED_ROOT = { ...MATERIAL, cashRootHex: OTHER_MATERIAL.cashRootHex };
const SLOT_STORAGE_KEY = 'sattle_passkey_slots';

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

const rawSlots = (): string => localStorage.getItem(SLOT_STORAGE_KEY) ?? '';

beforeEach(async () => {
  stubLocalStorage();
  await saveWalletMaterial(MATERIAL);
});

describe('exact wallet material passkey commitment', () => {
  it('rejects a wrong old PRF before changing any slot bytes', async () => {
    const authenticator = new FakeAuthenticator();
    const slot = await registerPasskey(MATERIAL, { credentials: authenticator });
    const before = rawSlots();
    const wrongPrf = new Uint8Array(32).fill(99);

    await expect(
      rewrapAllSlots(MATERIAL, new Map([[slot.credentialId, wrongPrf]])),
    ).rejects.toThrow();
    expect(rawSlots()).toBe(before);
  });

  it('rejects same-owner altered-root registration against encrypted saved material', async () => {
    const authenticator = new FakeAuthenticator();
    await saveWalletMaterial(MATERIAL, 'password');

    await expect(registerPasskey(ALTERED_ROOT, { credentials: authenticator })).rejects.toThrow(
      'saved wallet material',
    );
    expect(rawSlots()).toBe('');
  });

  it('rejects registration when same-owner saved material changes during the ceremony', async () => {
    const authenticator = new FakeAuthenticator();
    authenticator.onCreate = () => saveWalletMaterial(ALTERED_ROOT);

    await expect(registerPasskey(MATERIAL, { credentials: authenticator })).rejects.toThrow(
      'saved wallet material',
    );
    expect(rawSlots()).toBe('');
  });

  it('rejects unlock after same-owner saved material was replaced', async () => {
    const authenticator = new FakeAuthenticator();
    await registerPasskey(MATERIAL, { credentials: authenticator });
    await saveWalletMaterial(ALTERED_ROOT, 'password');

    await expect(unlockWalletMaterialWithPasskey({ credentials: authenticator })).rejects.toThrow();
  });

  it('rejects same-owner saved-material replacement during the unlock ceremony', async () => {
    const authenticator = new FakeAuthenticator();
    await registerPasskey(MATERIAL, { credentials: authenticator });
    authenticator.onGet = () => saveWalletMaterial(ALTERED_ROOT);

    await expect(unlockWalletMaterialWithPasskey({ credentials: authenticator })).rejects.toThrow(
      'changed',
    );
  });

  it('keeps a valid slot usable when its old PRF proves the existing wrap', async () => {
    const authenticator = new FakeAuthenticator();
    const slot = await registerPasskey(MATERIAL, { credentials: authenticator });
    const oldPrf = await getPasskeyPrfOutput(slot.credentialId, { credentials: authenticator });

    await rewrapAllSlots(MATERIAL, new Map([[slot.credentialId, oldPrf]]));

    await expect(unlockWalletMaterialWithPasskey({ credentials: authenticator })).resolves.toEqual(
      MATERIAL,
    );
  });
});
