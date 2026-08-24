// Lock vs NWC drain integration: an accepted pay_invoice that already
// crossed its irreversible melt must reach its truthful durable outcome
// (budget debit, spent bearer, success response) BEFORE wallet.lock()
// invalidates the lifecycle fence and clears runtime keys. Uses the real
// wallet store, the real NWC store, the real service, and the real owner
// fence - only the relay transport is fake and the mint is the local
// conformance mock. Regresses the ordering where lock invalidated the
// captured fence first, leaving a debited budget, a locally unspent burned
// bearer, and no response.

import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildNoteUrl, fetchNoteInfo } from 'lnurlcash-kit';
import { createMockMint } from 'lnurlcash-conformance/mock-mint';
import { v2 as nip44v2 } from 'nostr-tools/nip44';

import { NWC_RESPONSE_KIND, createConnection, readNwcConnections } from '@/lnurlcash/nwc';
import type { NostrEvent } from '@/lnurlcash/nwc';
import { isJsonObject } from '@/lnurlcash/jsonParsing';
import { requiredValue, stubLocalStorage } from '@/lnurlcash/test-utils';
import {
  CLIENT_SECRET,
  RELAYS,
  createFakeRelay,
  deferred,
  methodRequest,
  waitFor,
} from '@/lnurlcash/nwc.testProtocol';
import { setNwcTransportForTests, useNwcStore } from './nwc';
import { useWalletStore } from './wallet';

const PASSWORD = 'correct horse battery staple';
// decodes to exactly 21_000 msat, matching the credited note (exact carve)
const INVOICE_21K = 'lnbc210n1pjqrstuvwxyz';

type NwcResponsePayload = {
  result_type: string;
  error: { code: string; message: string } | null;
  result: Record<string, unknown> | null;
};

const isNwcResponsePayload = (value: unknown): value is NwcResponsePayload =>
  isJsonObject(value) &&
  typeof value.result_type === 'string' &&
  (value.error === null ||
    (isJsonObject(value.error) &&
      typeof value.error.code === 'string' &&
      typeof value.error.message === 'string')) &&
  (value.result === null || isJsonObject(value.result));

const readResponse = (published: NostrEvent[], requestId: string): NwcResponsePayload | null => {
  const event = published.find(
    (candidate) =>
      candidate.kind === NWC_RESPONSE_KIND &&
      candidate.tags.some((tag) => tag[0] === 'e' && tag[1] === requestId),
  );
  if (!event) return null;
  const plaintext = nip44v2.decrypt(
    event.content,
    nip44v2.utils.getConversationKey(CLIENT_SECRET, event.pubkey),
  );
  const parsed: unknown = JSON.parse(plaintext);
  if (!isNwcResponsePayload(parsed)) throw new TypeError('Expected a valid NWC response payload.');
  return parsed;
};

type Mint = Awaited<ReturnType<typeof createMockMint>>;
const mints: Mint[] = [];

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('navigator', {});
  stubLocalStorage();
  setActivePinia(createPinia());
});

afterEach(async () => {
  setNwcTransportForTests(null);
  await Promise.all(mints.splice(0).map((mint) => mint.close()));
});

describe('wallet lock with an in-flight NWC payment', () => {
  it('drains an accepted post-melt pay to its durable outcome before invalidating the lifecycle', async () => {
    // Given an encrypted unlocked wallet holding one exact-match note, served
    // by a running NWC service over the fake relay
    const mint = await createMockMint();
    mints.push(mint);
    const wallet = useWalletStore();
    await wallet.create(PASSWORD);
    const k1 = 'e1'.repeat(32);
    mint.state.creditNote(k1, 21_000);
    const noteUrl = buildNoteUrl(`${mint.url}/w`, k1, 21_000);
    const noteInfo = await fetchNoteInfo(noteUrl);
    const [bearer] = await wallet.addBearers(
      [
        {
          url: noteUrl,
          callback: noteInfo.callback,
          amount: noteInfo.maxWithdrawable,
          verified: true,
          mintPubkey: mint.state.pubkey,
        },
      ],
      wallet.captureOwnerFence(),
    );
    if (!bearer) throw new Error('Expected the added bearer.');
    const ownerId = wallet.pubkey;
    if (ownerId === null) throw new Error('Expected an unlocked owner.');
    const connection = createConnection(wallet.requireLinkingKey(), {
      relays: RELAYS,
      budget: { maxMsat: 1_000_000_000, periodMs: 86_400_000 },
      clientSecret: CLIENT_SECRET,
    });
    const relay = createFakeRelay();
    setNwcTransportForTests(relay.transport);
    const nwc = useNwcStore();
    await nwc.setEnabled(true);
    expect(nwc.running).toBe(true);

    // ... and a pay that crosses the irreversible melt, then pauses at the
    // durable bearer commit
    const releaseCommit = deferred();
    let commitReached = false;
    const applyChangeset = wallet.applyChangeset;
    vi.spyOn(wallet, 'applyChangeset').mockImplementation(async (changeset, ownerFence) => {
      commitReached = true;
      await releaseCommit.promise;
      return applyChangeset(changeset, ownerFence);
    });
    const request = methodRequest(
      connection.walletServicePubkey,
      'pay_invoice',
      { invoice: INVOICE_21K },
      'nip44_v2',
      Math.floor(Date.now() / 1000),
    );
    relay.emit(request);
    await waitFor(() => commitReached);
    expect(mint.state.noteState(k1)).toBe('burned');

    // When the holder locks the wallet mid-flight
    let lockSettled = false;
    const locking = wallet.lock().then(() => {
      lockSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Then the lock waits for the accepted pay instead of invalidating its
    // commit: the lifecycle stays commit-capable while subscriptions are
    // already closed, so no new work is accepted once the lock began
    expect(lockSettled).toBe(false);
    expect(wallet.state).toBe('unlocked');
    expect(relay.subscriptionCount()).toBe(0);
    const lateRequest = methodRequest(
      connection.walletServicePubkey,
      'get_balance',
      {},
      'nip44_v2',
      Math.floor(Date.now() / 1000),
    );
    relay.emitAfterClose(lateRequest);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(readResponse(relay.published, lateRequest.id)).toBeNull();

    // When the paused payment resumes
    releaseCommit.resolve();

    // Then the client receives its deterministic success BEFORE the lock
    // completes, and budget and bearer state commit consistently
    await waitFor(() => readResponse(relay.published, request.id) !== null);
    const response = requiredValue(readResponse(relay.published, request.id));
    expect(response.error).toBeNull();
    expect(typeof response.result?.preimage).toBe('string');
    expect(readNwcConnections(ownerId)[0]?.spent.msat).toBe(21_000);
    await locking;
    expect(wallet.state).toBe('locked');
    expect(wallet.bearers).toEqual([]);
    expect(() => wallet.requireLinkingKey()).toThrow('Wallet is locked.');
    expect(nwc.running).toBe(false);

    // ... and the spent note survives the lock durably
    await wallet.unlock(PASSWORD);
    expect(wallet.bearers.find((candidate) => candidate.id === bearer.id)?.spent).toBe(true);
    await nwc.setEnabled(false);
  });
});
