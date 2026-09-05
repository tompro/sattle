import { describe, expect, it } from 'vitest';
import { hashK1, noteK1 } from 'lnurlcash-kit';

import { claimMintedNote, OutputSecretAllocationRequiredError, prepareMint } from './ops';
import { requiredValue } from './test-utils';
import type { Mint } from './ops.testHarness';
import {
  allocateOutputSecrets,
  mint,
  persistOutput,
  secret,
  settleLastInvoice,
} from './ops.testHarness';

const HEX32 = /^[0-9a-f]{64}$/;

const boundInvoice = (instance: Mint) =>
  [...instance.state.invoices.values()].find((invoice) => invoice.boundTo);

describe('mint -> claim, comment-bound output', () => {
  it('names the quote with the hash of a wallet-chosen secret', async () => {
    const instance = await mint({ testHooks: true });
    const prepared = await prepareMint(`mint@127.0.0.1:${instance.port}`, 21_000, {
      persistOutput,
      allocateOutputSecrets,
    });
    expect(prepared.noteSecret).toMatch(HEX32);
    expect(boundInvoice(instance)?.boundTo).toBe(hashK1(prepared.noteSecret));
  });

  it('claims the output at the wallet secret without rotating it', async () => {
    const instance = await mint({ testHooks: true });
    const prepared = await prepareMint(`mint@127.0.0.1:${instance.port}`, 21_000, {
      persistOutput,
      allocateOutputSecrets,
    });
    const preimage = await settleLastInvoice(instance);
    const claimed = await claimMintedNote(prepared, {
      intervalMs: 10,
      intervalCapMs: 50,
      maxWaitMs: 5_000,
    });
    expect(claimed.note.verified).toBe(true);
    expect(claimed.note.amount).toBe(21_000);
    expect(claimed.note.callback).toBe(`${instance.url}/w/cb`);
    expect(noteK1(claimed.note.url)).toBe(prepared.noteSecret);
    expect(instance.state.noteState(prepared.noteSecret)).toBe('outstanding');
    expect(instance.state.noteState(preimage)).toBeNull();
  });

  it('times out cleanly when the invoice is never paid', async () => {
    const instance = await mint({ testHooks: true });
    const prepared = await prepareMint(`mint@127.0.0.1:${instance.port}`, 21_000, {
      persistOutput,
      allocateOutputSecrets,
    });
    await expect(
      claimMintedNote(prepared, { intervalMs: 10, intervalCapMs: 20, maxWaitMs: 100 }),
    ).rejects.toThrow(/not confirmed/i);
  });

  it('uses the required comment even when the optional h extension is advertised', async () => {
    const instance = await mint({ mintToHash: true, testHooks: true });
    const prepared = await prepareMint(`mint@127.0.0.1:${instance.port}`, 21_000, {
      persistOutput,
      allocateOutputSecrets,
    });
    expect(boundInvoice(instance)?.boundTo).toBe(hashK1(prepared.noteSecret));
    await settleLastInvoice(instance);
    const claimed = await claimMintedNote(prepared, {
      intervalMs: 10,
      intervalCapMs: 50,
      maxWaitMs: 5_000,
    });
    expect(noteK1(claimed.note.url)).toBe(prepared.noteSecret);
    expect(requiredValue(noteK1(claimed.note.url))).toMatch(HEX32);
  });

  it('draws the staged note secret from the caller allocation path', async () => {
    const instance = await mint({ testHooks: true });
    const allocations: Array<{ server: string; count: number }> = [];
    const allocated = [secret('90')];

    const prepared = await prepareMint(`mint@127.0.0.1:${instance.port}`, 21_000, {
      persistOutput,
      allocateOutputSecrets: (server, count) => {
        allocations.push({ server, count });
        return Promise.resolve(allocated.slice(0, count));
      },
    });

    expect(allocations).toEqual([{ server: `127.0.0.1:${instance.port}`, count: 1 }]);
    expect(prepared.noteSecret).toBe(allocated[0]);
    expect(boundInvoice(instance)?.boundTo).toBe(hashK1(requiredValue(allocated[0])));
  });

  it('refuses to prepare without an allocation path - nothing staged, no invoice', async () => {
    const instance = await mint({ testHooks: true });
    let persisted = 0;

    await expect(
      prepareMint(`mint@127.0.0.1:${instance.port}`, 21_000, {
        persistOutput: () => {
          persisted += 1;
        },
      }),
    ).rejects.toBeInstanceOf(OutputSecretAllocationRequiredError);

    expect(persisted).toBe(0);
    expect(instance.state.invoices.size).toBe(0);
  });
});
