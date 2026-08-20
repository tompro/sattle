// Deep-link parsing: the pure classification half of the capability.
// Fixtures mirror what actually arrives via Android intents and the PWA
// protocol handler - scheme-wrapped invoices, lnurlw bearer links, bech32.
import { describe, expect, it } from 'vitest';
import { toBech32Lnurl } from 'lnurlcash-kit';

import { parseExternalInput } from './deepLinks';

const K1 = 'ab'.repeat(32);
const NOTE_URL = `lnurlw://mint.example/withdraw?k1=${K1}`;
const INVOICE = 'lnbc210n1pqqqqqqqqqqqqqqqqqqqq';

describe('parseExternalInput', () => {
  it('routes an lnurlw:// bearer link to receive', () => {
    expect(parseExternalInput(NOTE_URL)).toEqual({ kind: 'note', value: expect.any(String) });
    expect(parseExternalInput(NOTE_URL)?.value).toContain('k1=');
  });

  it('routes a bech32 lnurl carrying a k1 to receive', () => {
    const bech32 = toBech32Lnurl(`https://mint.example/withdraw?k1=${K1}`);
    expect(parseExternalInput(bech32)).toEqual({ kind: 'note', value: expect.any(String) });
  });

  it('strips the lightning: scheme from invoices and routes to pay', () => {
    expect(parseExternalInput(`lightning:${INVOICE}`)).toEqual({ kind: 'pay', value: INVOICE });
  });

  it('handles the uppercase LIGHTNING: scheme', () => {
    expect(parseExternalInput(`LIGHTNING:${INVOICE.toUpperCase()}`)).toEqual({
      kind: 'pay',
      value: INVOICE.toUpperCase(),
    });
  });

  it('routes a bare bolt11 invoice to pay', () => {
    expect(parseExternalInput(INVOICE)).toEqual({ kind: 'pay', value: INVOICE });
  });

  it('strips the PWA web+ prefix from protocol-handler launches', () => {
    expect(parseExternalInput(`web+lightning:${INVOICE}`)).toEqual({
      kind: 'pay',
      value: INVOICE,
    });
  });

  it('routes a Lightning Address to pay', () => {
    expect(parseExternalInput('alice@example.com')).toEqual({
      kind: 'pay',
      value: 'alice@example.com',
    });
  });

  it('routes an lnurlp:// link to pay', () => {
    const link = 'lnurlp://pay.example/.well-known/lnurlp/alice';
    expect(parseExternalInput(link)).toEqual({ kind: 'pay', value: link });
  });

  it('routes a lightning:-wrapped bearer note to receive, not pay', () => {
    const result = parseExternalInput(`lightning:${NOTE_URL}`);
    expect(result?.kind).toBe('note');
  });

  it('rejects empty and unrecognized input', () => {
    expect(parseExternalInput('')).toBeNull();
    expect(parseExternalInput('   ')).toBeNull();
    expect(parseExternalInput('hello world')).toBeNull();
    expect(parseExternalInput('https://example.com/page')).toBeNull();
    // an lnurlw link WITHOUT a k1 is neither a note nor payable
    expect(parseExternalInput('lnurlw://mint.example/withdraw')).toBeNull();
  });
});
