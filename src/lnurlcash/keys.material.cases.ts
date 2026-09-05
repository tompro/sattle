import { describe, expect, it } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils.js';
import { getPublicKey } from 'nostr-tools/pure';
import { cashNodeToHex } from 'lnurlcash-kit';

import {
  deriveBearerAesKey,
  deriveWalletLinkingKey,
  deriveWalletMaterial,
  linkingPubKeyHex,
  parseWalletMaterial,
  serializeWalletMaterial,
  walletMaterialCashRoot,
  walletMaterialLinkingKey,
} from './keys';
import { backupPubkey, deriveBackupKey } from './nostrBackup';
import { deriveNwcWalletKey, nwcWalletPubkey } from './nwc';

const FIXED_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const CLIENT_PUBKEY = getPublicKey(new Uint8Array(32).fill(17));
const LINKING_KEY_HEX = 'da2a752d3d28668288ff50bed644e4a95f726d8711fd8754060f0a9e378f84aa';
const CASH_ROOT_HEX =
  'c7a2496e9b453a67c5d2a1f04936ec1259440d45454c795a99a66269e4cd3005111e1cc966fca2fe32f054f14caceab90449e536d94cf6935ea12a087e414f60';

describe('fixed mnemonic identity characterization', () => {
  it('pins every public linking-key-derived identity and bearer encryption behavior', async () => {
    // Given a mnemonic accepted by the existing wallet derivation
    const linkingKey = deriveWalletLinkingKey(FIXED_MNEMONIC);
    const bearerKey = await deriveBearerAesKey(linkingKey);

    // When its owner, bearer, Nostr, and NWC observables are derived
    const bearerCiphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: new Uint8Array(12) },
        bearerKey,
        new TextEncoder().encode('sattle-vector-v1'),
      ),
    );

    // Then they match the pre-v2 wallet's independently captured vectors
    expect(linkingPubKeyHex(linkingKey)).toBe(
      '0249f93654b6db2c0c4194c2fbc5eb54ff36f055e82bb867321a4c7ec7f7c31481',
    );
    expect(bytesToHex(bearerCiphertext)).toBe(
      '4caf30a7c3fdb53ad3edefb34f202a67a2e969f267db3a5842ee6cfd23032e78',
    );
    expect(backupPubkey(deriveBackupKey(linkingKey))).toBe(
      '6b6dc0633162e1985316d06edb85a99cc31f89b9c42d350ffdcf57853b875577',
    );
    expect(nwcWalletPubkey(deriveNwcWalletKey(linkingKey, CLIENT_PUBKEY))).toBe(
      '3aa81f13d0dbccba0df5772abccda43c9a51c1dc99ea9a76090cada33b9fc587',
    );
  });
});

describe('WalletMaterialV2 derivation and serialization', () => {
  it('derives the unchanged linking key and kit cash root from one mnemonic', () => {
    // Given the fixed recovery mnemonic
    // When its complete wallet material is derived
    const material = deriveWalletMaterial(FIXED_MNEMONIC);

    // Then both independently captured vectors and the exact schema are stable
    expect(material).toEqual({
      version: 2,
      linkingKeyHex: LINKING_KEY_HEX,
      cashRootHex: CASH_ROOT_HEX,
    });
    expect(Object.keys(material)).toEqual(['version', 'linkingKeyHex', 'cashRootHex']);
    expect(walletMaterialLinkingKey(material)).toEqual(deriveWalletLinkingKey(FIXED_MNEMONIC));
    expect(cashNodeToHex(walletMaterialCashRoot(material))).toBe(CASH_ROOT_HEX);
  });

  it('round-trips only the canonical exact serialization', () => {
    // Given valid v2 material
    const material = deriveWalletMaterial(FIXED_MNEMONIC);

    // When it crosses the serialization boundary
    const serialized = serializeWalletMaterial(material);

    // Then its bytes and parsed value are canonical
    expect(serialized).toBe(
      `{"version":2,"linkingKeyHex":"${LINKING_KEY_HEX}","cashRootHex":"${CASH_ROOT_HEX}"}`,
    );
    expect(parseWalletMaterial(serialized)).toEqual(material);
  });

  it.each([
    ['legacy key only', LINKING_KEY_HEX],
    [
      'wrong version',
      JSON.stringify({ version: 1, linkingKeyHex: LINKING_KEY_HEX, cashRootHex: CASH_ROOT_HEX }),
    ],
    ['missing field', JSON.stringify({ version: 2, linkingKeyHex: LINKING_KEY_HEX })],
    [
      'extra field',
      JSON.stringify({
        version: 2,
        linkingKeyHex: LINKING_KEY_HEX,
        cashRootHex: CASH_ROOT_HEX,
        seed: 'forbidden',
      }),
    ],
    [
      'uppercase linking key',
      JSON.stringify({
        version: 2,
        linkingKeyHex: LINKING_KEY_HEX.toUpperCase(),
        cashRootHex: CASH_ROOT_HEX,
      }),
    ],
    [
      'truncated linking key',
      JSON.stringify({
        version: 2,
        linkingKeyHex: LINKING_KEY_HEX.slice(2),
        cashRootHex: CASH_ROOT_HEX,
      }),
    ],
    [
      'uppercase cash root',
      JSON.stringify({
        version: 2,
        linkingKeyHex: LINKING_KEY_HEX,
        cashRootHex: CASH_ROOT_HEX.toUpperCase(),
      }),
    ],
    [
      'truncated cash root',
      JSON.stringify({
        version: 2,
        linkingKeyHex: LINKING_KEY_HEX,
        cashRootHex: CASH_ROOT_HEX.slice(2),
      }),
    ],
    [
      'invalid cash root private key',
      JSON.stringify({
        version: 2,
        linkingKeyHex: LINKING_KEY_HEX,
        cashRootHex: '00'.repeat(32) + CASH_ROOT_HEX.slice(64),
      }),
    ],
    [
      'non-canonical field order',
      JSON.stringify({ cashRootHex: CASH_ROOT_HEX, linkingKeyHex: LINKING_KEY_HEX, version: 2 }),
    ],
  ])('rejects %s', (_name, serialized) => {
    // Given malformed or non-canonical serialized material
    // When it crosses the parser
    const parsed = parseWalletMaterial(serialized);

    // Then no trusted material is returned
    expect(parsed).toBeNull();
  });
});
