// Saved secret records bind either the legacy linking key or canonical v2
// wallet material to a proven owner. The v2 parser accepts only one exact,
// canonical material encoding so hostile storage cannot smuggle a legacy key,
// a future field, or a malformed BIP-32 root across the unlock boundary.

import { isJsonObject } from '../jsonParsing';
import { isWalletOwnerId } from './walletOwner';
import {
  parseWalletMaterial,
  serializedWalletMaterialHash,
  STORED_WALLET_MATERIAL_VERSION,
} from './walletMaterial';
export {
  parseWalletMaterial,
  serializeWalletMaterial,
  walletMaterialHash,
  walletMaterialOwnerId,
  WALLET_MATERIAL_VERSION,
} from './walletMaterial';
export type { WalletMaterialV2 } from './walletMaterial';

export const STORED_SECRET_VERSION = 1 as const;
export { STORED_WALLET_MATERIAL_VERSION } from './walletMaterial';

type PlainStoredSecret = {
  readonly enc: false;
  readonly value: string;
  readonly ownerId?: unknown;
  readonly version?: unknown;
};

type EncryptedStoredSecret = {
  readonly enc: true;
  readonly salt: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly ownerId?: unknown;
  readonly version?: unknown;
};

export type StoredSecret = PlainStoredSecret | EncryptedStoredSecret;
export type StoredWalletMaterial = StoredSecret & { readonly materialHash: string };

type ParsedStoredSecret = {
  readonly secret: StoredSecret;
  readonly claimedOwnerId: string | null;
  readonly isCurrent: boolean;
};

type ParsedStoredWalletMaterial = Omit<ParsedStoredSecret, 'secret'> & {
  readonly secret: StoredWalletMaterial;
};

const PLAIN_KEYS = ['enc', 'value', 'ownerId', 'version'] as const;
const ENCRYPTED_KEYS = ['enc', 'salt', 'iv', 'ciphertext', 'ownerId', 'version'] as const;
const PLAIN_MATERIAL_KEYS = [...PLAIN_KEYS, 'materialHash'] as const;
const ENCRYPTED_MATERIAL_KEYS = [...ENCRYPTED_KEYS, 'materialHash'] as const;

const hasOnlyKeys = (record: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(record).every((key) => allowed.includes(key));

type StoredSecretParserOptions = {
  readonly version: number;
  readonly acceptsPlaintext: (value: string) => boolean;
  readonly acceptsUnversionedOwner: boolean;
  readonly plainKeys: readonly string[];
  readonly encryptedKeys: readonly string[];
};

const parseStoredSecretWith = (
  stored: unknown,
  options: StoredSecretParserOptions,
): ParsedStoredSecret | null => {
  if (!isJsonObject(stored)) return null;
  let secret: StoredSecret;
  if (stored.enc === false) {
    if (
      typeof stored.value !== 'string' ||
      !options.acceptsPlaintext(stored.value) ||
      !hasOnlyKeys(stored, options.plainKeys)
    ) {
      return null;
    }
    secret = { enc: false, value: stored.value };
  } else if (stored.enc === true) {
    if (
      typeof stored.salt !== 'string' ||
      !/^[0-9a-f]{32}$/i.test(stored.salt) ||
      typeof stored.iv !== 'string' ||
      !/^[0-9a-f]{24}$/i.test(stored.iv) ||
      typeof stored.ciphertext !== 'string' ||
      stored.ciphertext.length === 0 ||
      stored.ciphertext.length % 2 !== 0 ||
      !/^[0-9a-f]+$/i.test(stored.ciphertext) ||
      !hasOnlyKeys(stored, options.encryptedKeys)
    ) {
      return null;
    }
    secret = {
      enc: true,
      salt: stored.salt,
      iv: stored.iv,
      ciphertext: stored.ciphertext,
    };
  } else {
    return null;
  }

  const hasOwner = Object.hasOwn(stored, 'ownerId');
  const hasVersion = Object.hasOwn(stored, 'version');
  if (!hasOwner && !hasVersion) return { secret, claimedOwnerId: null, isCurrent: false };
  if (!isWalletOwnerId(stored.ownerId)) return null;
  if (!hasVersion) {
    if (!options.acceptsUnversionedOwner) return null;
    return {
      secret: { ...secret, ownerId: stored.ownerId },
      claimedOwnerId: stored.ownerId,
      isCurrent: false,
    };
  }
  if (stored.version !== options.version) return null;
  return {
    secret: { ...secret, ownerId: stored.ownerId, version: options.version },
    claimedOwnerId: stored.ownerId,
    isCurrent: true,
  };
};

export const parseStoredSecret = (stored: unknown): ParsedStoredSecret | null =>
  parseStoredSecretWith(stored, {
    version: STORED_SECRET_VERSION,
    acceptsPlaintext: (value) => /^[0-9a-f]{64}$/i.test(value),
    acceptsUnversionedOwner: true,
    plainKeys: PLAIN_KEYS,
    encryptedKeys: ENCRYPTED_KEYS,
  });

export const parseStoredWalletMaterial = (stored: unknown): ParsedStoredWalletMaterial | null => {
  if (
    !isJsonObject(stored) ||
    typeof stored.materialHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(stored.materialHash)
  ) {
    return null;
  }
  const materialHash = stored.materialHash;
  const parsed = parseStoredSecretWith(stored, {
    version: STORED_WALLET_MATERIAL_VERSION,
    acceptsPlaintext: (value) => parseWalletMaterial(value) !== null,
    acceptsUnversionedOwner: false,
    plainKeys: PLAIN_MATERIAL_KEYS,
    encryptedKeys: ENCRYPTED_MATERIAL_KEYS,
  });
  if (
    parsed === null ||
    (parsed.secret.enc === false &&
      serializedWalletMaterialHash(parsed.secret.value) !== materialHash)
  ) {
    return null;
  }
  const secret: StoredWalletMaterial = { ...parsed.secret, materialHash };
  return { ...parsed, secret };
};

export const isValidStoredSecret = (stored: unknown): stored is StoredSecret =>
  parseStoredSecret(stored) !== null;

export const isValidStoredWalletMaterial = (stored: unknown): stored is StoredWalletMaterial =>
  parseStoredWalletMaterial(stored) !== null;

export const storedSecretOwnerId = (stored: StoredSecret): string | null => {
  const parsed = parseStoredSecret(stored);
  return parsed?.isCurrent === true ? parsed.claimedOwnerId : null;
};

export const storedSecretClaimedOwnerId = (stored: StoredSecret): string | null =>
  parseStoredSecret(stored)?.claimedOwnerId ?? null;

export const storedWalletMaterialOwnerId = (stored: StoredWalletMaterial): string | null => {
  const parsed = parseStoredWalletMaterial(stored);
  return parsed?.isCurrent === true ? parsed.claimedOwnerId : null;
};

export const storedWalletMaterialClaimedOwnerId = (stored: StoredWalletMaterial): string | null =>
  parseStoredWalletMaterial(stored)?.claimedOwnerId ?? null;

export const stampStoredSecretOwner = (stored: StoredSecret, ownerId: string): StoredSecret => {
  if (stored.enc === false) {
    return { enc: false, value: stored.value, ownerId, version: STORED_SECRET_VERSION };
  }
  return {
    enc: true,
    salt: stored.salt,
    iv: stored.iv,
    ciphertext: stored.ciphertext,
    ownerId,
    version: STORED_SECRET_VERSION,
  };
};

export const stampStoredWalletMaterialOwner = (
  stored: StoredWalletMaterial,
  ownerId: string,
): StoredWalletMaterial => {
  if (stored.enc === false) {
    return {
      enc: false,
      value: stored.value,
      materialHash: stored.materialHash,
      ownerId,
      version: STORED_WALLET_MATERIAL_VERSION,
    };
  }
  return {
    enc: true,
    salt: stored.salt,
    iv: stored.iv,
    ciphertext: stored.ciphertext,
    materialHash: stored.materialHash,
    ownerId,
    version: STORED_WALLET_MATERIAL_VERSION,
  };
};

export const stripStoredSecretOwner = (stored: StoredSecret): StoredSecret => {
  if (stored.enc === false) return { enc: false, value: stored.value };
  return {
    enc: true,
    salt: stored.salt,
    iv: stored.iv,
    ciphertext: stored.ciphertext,
  };
};

export const stripStoredWalletMaterialOwner = (
  stored: StoredWalletMaterial,
): StoredWalletMaterial => {
  if (stored.enc === false) {
    return { enc: false, value: stored.value, materialHash: stored.materialHash };
  }
  return {
    enc: true,
    salt: stored.salt,
    iv: stored.iv,
    ciphertext: stored.ciphertext,
    materialHash: stored.materialHash,
  };
};
