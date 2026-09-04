// The wallet's deterministic-secret and signed-output work depends on this
// exact installed API surface, so package drift must fail before funds code runs.

import {describe, expect, it} from 'vitest'
import {
  cashNodeFromHex,
  cashNodeToHex,
  cashSecretSource,
  deriveCashRoot,
  restoreFromSeed,
  verifyNoteSignature,
  verifyNoteSignatureAgainst,
  verifyNoteSignatureHash,
  verifyNoteSignatureHashAgainst,
} from 'lnurlcash-kit'
import type {LnurlcashOptions} from 'lnurlcash-kit'
import conformancePackage from '../../node_modules/lnurlcash-conformance/package.json'
import kitPackage from '../../node_modules/lnurlcash-kit/package.json'

const retryOptions = {mutationRetries: 1} satisfies LnurlcashOptions
const requiredExports = [
  deriveCashRoot,
  cashNodeToHex,
  cashNodeFromHex,
  cashSecretSource,
  restoreFromSeed,
  verifyNoteSignature,
  verifyNoteSignatureAgainst,
  verifyNoteSignatureHash,
  verifyNoteSignatureHashAgainst,
] as const

describe('lnurlcash 0.8 dependency contract', () => {
  it('exposes the BIP-32, recovery, signature, and retry contracts', () => {
    expect(requiredExports.every((value) => typeof value === 'function')).toBe(true)
    expect(retryOptions.mutationRetries).toBe(1)
  })

  it('runs against the exact installed package versions', () => {
    expect(kitPackage.version).toBe('0.8.0')
    expect(conformancePackage.version).toBe('0.7.0')
  })
})
