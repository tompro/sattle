// The NWC wallet service end to end: connection strings and key
// derivation, the request/response cycle over an in-memory relay (the
// transport is injected - no network), every method against the
// conformance mock mint, the legacy NIP-04 path, budget enforcement, and
// the error paths. Fund-safety focus: budgets can't be exceeded, stale
// requests never execute, and a settled preimage only ever reveals an
// already-rotated (burned) note secret.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { encrypt as nip04Encrypt, decrypt as nip04Decrypt } from 'nostr-tools/nip04';
import { v2 as nip44v2 } from 'nostr-tools/nip44';
import { buildNoteUrl, fetchNoteInfo, hashK1, noteK1 } from 'lnurlcash-kit';
import { createMockMint } from 'lnurlcash-conformance/mock-mint';

import {
  NWC_INFO_KIND,
  NWC_REQUEST_KIND,
  NWC_RESPONSE_KIND,
  buildConnectionString,
  connectionInfoOf,
  createConnection,
  deriveNwcWalletKey,
  migrateLegacyNwcStorage,
  parseConnectionString,
  readNwcEnabled,
  readNwcConnections,
  startService,
  writeNwcEnabled,
  writeNwcConnections,
} from './nwc';
import type { NostrEvent, NwcConnectionRecord, NwcServiceDeps, NwcTransport } from './nwc';
import type { NostrFilter } from './nwc/transport';
import type { NwcChangeset } from './nwc';
import type { Bearer } from './types';
import { ensureSavedKeyOwner, linkingPubKeyHex, saveLinkingKey } from './keys';
import { requiredString, requiredValue, stubLocalStorage } from './test-utils';

import {
  CLIENT_PUBKEY,
  CLIENT_SECRET,
  FAST_POLL,
  LINKING_KEY,
  OTHER_LINKING_KEY,
  OTHER_OWNER_ID,
  OWNER_ID,
  RELAYS,
  STRANGER_SECRET,
  clientRequest,
  createFakeRelay,
  deferred,
  foreignConnectionFixture,
  methodRequest,
  nowSeconds,
  storeForeignConnection,
  waitFor,
} from './nwc.testProtocol';
import { call, makeBearer, mint, readResponse, startTestService } from './nwc.testService';
import { invoiceRetireAfter } from './nwc/invoices';

export const SIGNED_BOLT11_FIXTURE =
  'lnbc250n1p4f4d2ysp5s7pqe2590jtlgpqyzw82m4xtn5wpkehf8jt4fcj754p4s2nf3r3qpp5d2zdf3satrdk5qllx00hwah5tlg69h90w5s78flfg8ffq4fagalsdqhd3h82unvvdshx6pqd45kuaqxqyjw5qcqpjrzjqwda3lfx6jhqd33847rqkfclpnyfv9f74pavem0mtvhdyzlam4lnkr83hqqq55cqqyqqqqqqqqqqzsqq9q9qxpqysgql3u9h88pw0pnfqdqh5hdgstgc8gazln7xeleuu7elmw7ea6q488js0mqwchtcq7rphv9uc3q5yqllx6ksdw8yjfq5e9jcgarlqzrk6gq5ksjdz';

describe('service: make_invoice / lookup_invoice', () => {
  it('derives a safe retirement time from a signed BOLT11 invoice', () => {
    expect(invoiceRetireAfter(SIGNED_BOLT11_FIXTURE)).toBeGreaterThan(0);
  });

  it('rejects a retirement time outside the safe integer range', () => {
    const timestamp = 'q'.repeat(7);
    const expiryTag = `xqv${'l'.repeat(12)}`;
    expect(invoiceRetireAfter(`lnbc1${timestamp}${expiryTag}qqqqqq`)).toBeNull();
  });

  it('stages an output, settles it in the background, and reports the preimage', async () => {
    const m = await mint({ testHooks: true });
    const { relay, walletServicePubkey, state, stop } = await startTestService({
      defaultMint: `mint@127.0.0.1:${m.port}`,
    });

    const made = await call(relay, walletServicePubkey, 'make_invoice', {
      amount: 21_000,
      description: 'nwc test',
      expiry: 3600,
    });
    expect(made.error).toBeNull();
    expect(made.result).toMatchObject({
      type: 'incoming',
      state: 'pending',
      amount: 21_000,
      description: 'nwc test',
      created_at: nowSeconds(),
      expires_at: nowSeconds() + 3600,
    });
    const invoice = requiredValue(made.result).invoice;
    if (typeof invoice !== 'string') {
      throw new TypeError('make_invoice did not return an invoice');
    }
    const paymentHash = made.result?.payment_hash;
    if (typeof paymentHash !== 'string') {
      throw new TypeError('make_invoice did not return a payment hash');
    }
    expect(invoice).toMatch(/^lnbc/);
    expect(paymentHash).toMatch(/^[0-9a-f]{64}$/);
    const staged = requiredValue(state.bearers.find((bearer) => bearer.id.startsWith('staged-')));
    expect(staged.verified).toBe(false);
    expect(staged.callback).toBe('');
    // before settlement the lookup reports the pending invoice
    const pending = await call(relay, walletServicePubkey, 'lookup_invoice', {
      payment_hash: paymentHash,
    });
    expect(pending.error).toBeNull();
    expect(pending.result?.state).toBe('pending');
    expect(pending.result?.preimage).toBeUndefined();

    // the "payer" pays the invoice; the background claim settles and
    // mints the note
    const settleRes = await fetch(`${m.url}/_test/settle?payment_hash=${paymentHash}`);
    expect(settleRes.ok).toBe(true);
    await waitFor(() => state.bearers.some((bearer) => bearer.verified));

    const settled = await call(relay, walletServicePubkey, 'lookup_invoice', {
      payment_hash: paymentHash,
    });
    expect(settled.error).toBeNull();
    expect(settled.result?.state).toBe('settled');
    expect(settled.result?.settled_at).toBe(nowSeconds());
    const preimage = requiredString(settled.result?.preimage);
    expect(preimage).toMatch(/^[0-9a-f]{64}$/);

    // The staged record was updated in place before settlement became
    // visible. The payment preimage is only a receipt and keys no note.
    expect(m.state.noteState(preimage)).toBeNull();
    const minted = requiredValue(state.bearers.find((b) => b.id === staged.id));
    expect(minted.amount).toBe(21_000);
    expect(minted.verified).toBe(true);
    expect(noteK1(minted.url)).not.toBe(preimage);
    expect(m.state.noteState(requiredValue(noteK1(minted.url)))).toBe('outstanding');
    await stop();
  });

  it('keeps a paid invoice pending while its bearer commit is deferred', async () => {
    const m = await mint({ testHooks: true });
    const commit = deferred();
    let commitStarted = false;
    const { relay, walletServicePubkey, state, stop } = await startTestService({
      defaultMint: `mint@127.0.0.1:${m.port}`,
      commitChangeset: () => {
        commitStarted = true;
        return commit.promise;
      },
    });
    const made = await call(relay, walletServicePubkey, 'make_invoice', {
      amount: 21_000,
    });
    const paymentHash = made.result?.payment_hash;
    if (typeof paymentHash !== 'string') {
      throw new TypeError('make_invoice did not return a payment hash');
    }

    const settleResponse = await fetch(`${m.url}/_test/settle?payment_hash=${paymentHash}`);
    expect(settleResponse.ok).toBe(true);
    await waitFor(() => commitStarted);

    const pending = await call(relay, walletServicePubkey, 'lookup_invoice', {
      payment_hash: paymentHash,
    });
    expect(pending.result?.state).toBe('pending');
    expect(pending.result?.settled_at).toBeUndefined();
    expect(pending.result?.preimage).toBeUndefined();

    commit.resolve();
    await waitFor(() => state.changesets.length === 1);
    const settled = await call(relay, walletServicePubkey, 'lookup_invoice', {
      payment_hash: paymentHash,
    });
    expect(settled.result?.state).toBe('settled');
    expect(settled.result?.settled_at).toBe(nowSeconds());
    expect(settled.result?.preimage).toMatch(/^[0-9a-f]{64}$/);
    await stop();
  });

  it('keeps repeated stops pending until an already-started invoice settlement commits', async () => {
    const m = await mint({ testHooks: true });
    const commit = deferred();
    let commitStarted = false;
    const { relay, walletServicePubkey, state, stop } = await startTestService({
      defaultMint: `mint@127.0.0.1:${m.port}`,
      commitChangeset: () => {
        commitStarted = true;
        return commit.promise;
      },
    });
    const made = await call(relay, walletServicePubkey, 'make_invoice', {
      amount: 21_000,
    });
    const paymentHash = made.result?.payment_hash;
    if (typeof paymentHash !== 'string') {
      throw new TypeError('make_invoice did not return a payment hash');
    }
    const settleResponse = await fetch(`${m.url}/_test/settle?payment_hash=${paymentHash}`);
    expect(settleResponse.ok).toBe(true);
    await waitFor(() => commitStarted);

    let stopped = false;
    const firstStop = stop().then(() => {
      stopped = true;
      return state.changesets.length;
    });
    const repeatedStop = stop();
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

    expect(stopped).toBe(false);
    expect(state.changesets).toHaveLength(0);

    commit.resolve();
    const [changesetsAtStop] = await Promise.all([firstStop, repeatedStop]);
    expect(changesetsAtStop).toBe(1);
    expect(state.changesets).toHaveLength(1);
  });
});
