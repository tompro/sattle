import { createPinia, setActivePinia } from 'pinia';
import { buildNoteUrl, fetchNoteInfo } from 'lnurlcash-kit';
import { createMockMint } from 'lnurlcash-conformance/mock-mint';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NWC_RESPONSE_KIND, createConnection, readNwcConnections } from '@/lnurlcash/nwc';
import type { NwcTransport } from '@/lnurlcash/nwc';
import { stubLocalStorage } from '@/lnurlcash/test-utils';
import {
  CLIENT_SECRET,
  RELAYS,
  createFakeRelay,
  deferred,
  methodRequest,
} from '@/lnurlcash/nwc.testProtocol';
import { setNwcTransportForTests, useNwcStore } from './nwc';
import { useWalletStore } from './wallet';

// a present-but-non-serializing LockManager fake: walletFunds serializes its
// own mutations, so single-store tests only need locks to EXIST
const stubPassthroughLocks = (): void => {
  vi.stubGlobal('navigator', {
    locks: { request: (_name: string, fn: () => unknown) => Promise.resolve().then(fn) },
  });
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  stubPassthroughLocks();
  stubLocalStorage();
  setActivePinia(createPinia());
  setNwcTransportForTests(null);
});

describe('NWC wallet lifecycle drain', () => {
  it('keeps one service when enabling twice', async () => {
    const wallet = useWalletStore();
    await wallet.create();
    const relay = createFakeRelay();
    setNwcTransportForTests(relay.transport);
    const nwc = useNwcStore();
    nwc.create(RELAYS, { maxMsat: 50_000, periodMs: 86_400_000 });

    await nwc.setEnabled(true);
    await nwc.setEnabled(true);

    expect(relay.subscriptionCount()).toBe(1);
    await nwc.stop();
    expect(relay.subscriptionCount()).toBe(0);
  });

  it('drains an accepted foreground fund operation before lock clears its fence', async () => {
    const wallet = useWalletStore();
    await wallet.create('password');
    const operation = wallet.beginFundOperation();
    let lockSettled = false;

    const locking = wallet.lock().then(() => {
      lockSettled = true;
    });
    await vi.waitFor(() => expect(() => wallet.captureOwnerFence()).toThrow());
    expect(lockSettled).toBe(false);
    operation.ownerFence();

    operation.complete();
    await locking;
    expect(wallet.state).toBe('locked');
  });

  it('commits an accepted melted payment before ordinary lock invalidates its owner fence', async () => {
    // Given a real encrypted wallet and NWC service whose payment is held
    // after the mint burned its note but before the wallet commits the delta
    const mint = await createMockMint();
    try {
      const wallet = useWalletStore();
      await wallet.create('password');
      const ownerId = wallet.pubkey;
      if (ownerId === null) throw new Error('Expected an unlocked owner.');
      const k1 = 'd7'.repeat(32);
      mint.state.creditNote(k1, 21_000);
      const url = buildNoteUrl(`${mint.url}/w`, k1, 21_000);
      const info = await fetchNoteInfo(url);
      await wallet.addBearers(
        [
          {
            url,
            callback: info.callback,
            amount: info.maxWithdrawable,
            verified: true,
            mintPubkey: mint.state.pubkey,
          },
        ],
        wallet.captureOwnerFence(),
      );
      const connection = createConnection(wallet.requireLinkingKey(), {
        relays: RELAYS,
        budget: { maxMsat: 50_000, periodMs: 86_400_000 },
        clientSecret: CLIENT_SECRET,
      });
      const relay = createFakeRelay();
      let accepted = false;
      const transport = {
        ...relay.transport,
        subscribe: (relays, filter, onEvent) =>
          relay.transport.subscribe(relays, filter, (event) => {
            accepted = true;
            onEvent(event);
          }),
      } satisfies NwcTransport;
      setNwcTransportForTests(transport);
      const nwc = useNwcStore();
      await nwc.setEnabled(true);
      expect(relay.subscriptionCount()).toBe(1);

      const commit = deferred();
      let commitStarted = false;
      const applyChangeset = wallet.applyChangeset.bind(wallet);
      vi.spyOn(wallet, 'applyChangeset').mockImplementation(async (changeset, ownerFence) => {
        commitStarted = true;
        await commit.promise;
        return applyChangeset(changeset, ownerFence);
      });
      const request = methodRequest(
        connection.walletServicePubkey,
        'pay_invoice',
        {
          invoice: 'lnbc210n1pjqrstuvwxyz',
        },
        'nip44_v2',
        Math.floor(Date.now() / 1000),
      );
      relay.emit(request);
      expect(accepted).toBe(true);
      await vi.waitFor(() => expect(commitStarted || nwc.lastError !== '').toBe(true), {
        timeout: 5_000,
      });
      expect(commitStarted, nwc.lastError).toBe(true);
      expect(mint.state.noteState(k1)).toBe('burned');
      expect(readNwcConnections(ownerId)[0]?.spent.msat).toBe(21_000);

      // When lock begins, it closes admission immediately but drains the
      // already accepted payment while that payment's fence remains valid
      let lockSettled = false;
      const locking = wallet.lock().then(() => {
        lockSettled = true;
      });
      await vi.waitFor(() => expect(relay.subscriptionCount()).toBe(0));
      expect(nwc.running).toBe(false);
      expect(lockSettled).toBe(false);
      expect(() => wallet.captureOwnerFence()).toThrow();
      expect(() => wallet.requireLinkingKey()).toThrow('Wallet is locked.');
      const rejected = methodRequest(
        connection.walletServicePubkey,
        'get_balance',
        {},
        'nip44_v2',
        Math.floor(Date.now() / 1000),
      );
      relay.emitAfterClose(rejected);
      expect(
        relay.published.some(
          (event) =>
            event.kind === NWC_RESPONSE_KIND &&
            event.tags.some((tag) => tag[0] === 'e' && tag[1] === rejected.id),
        ),
      ).toBe(false);

      // Then the accepted payment commits and responds before lock clears
      // runtime keys; after unlock, durable budget and bearer state agree
      commit.resolve();
      await locking;
      expect(wallet.state).toBe('locked');
      expect(() => wallet.requireLinkingKey()).toThrow('Wallet is locked.');
      await wallet.unlock('password');
      expect(wallet.bearers).toHaveLength(1);
      expect(wallet.bearers[0]?.spent).toBe(true);
      expect(readNwcConnections(ownerId)[0]?.spent.msat).toBe(21_000);
      expect(
        relay.published.some(
          (event) =>
            event.kind === NWC_RESPONSE_KIND &&
            event.tags.some((tag) => tag[0] === 'e' && tag[1] === request.id),
        ),
      ).toBe(true);
    } finally {
      setNwcTransportForTests(null);
      await mint.close();
    }
  });
});
