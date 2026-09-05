import { describe, expect, it } from 'vitest';
import { noteK1 } from 'lnurlcash-kit';

import {
  OutputSecretAllocationRequiredError,
  PayReturnCheckpointRequiredError,
  payWithBearers,
} from './ops';
import { requiredValue } from './test-utils';
import { allocateOutputSecrets, makeBearer, mint, secret } from './ops.testHarness';

describe('payWithBearers', () => {
  it('pays a bolt11 invoice by melting an exact note (settled)', async () => {
    const instance = await mint();
    const bearer = await makeBearer(instance, secret('30'), 21_000);
    const result = await payWithBearers([bearer], 'lnbc210n1pjqrstuvwxyz', {
      poll: { intervalMs: 10, intervalCapMs: 50, maxWaitMs: 5_000 },
    });
    expect(result.outcome).toBe('settled');
    expect(instance.state.noteState(secret('30'))).toBe('burned');
  });

  it('pays a Lightning Address by requesting an invoice first', async () => {
    const payer = await mint();
    const bearer = await makeBearer(payer, secret('31'), 21_000);
    const payeeFetch: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('https://payee.example/.well-known/lnurlp/alice')) {
        return Promise.resolve(
          Response.json({
            tag: 'payRequest',
            callback: 'https://payee.example/invoice',
            minSendable: 1_000,
            maxSendable: 100_000_000,
            metadata: '[]',
          }),
        );
      }
      if (url.startsWith('https://payee.example/invoice')) {
        return Promise.resolve(Response.json({ pr: 'lnbc210n1pjqrstuvwxyz' }));
      }
      return fetch(input, init);
    };
    const result = await payWithBearers([bearer], 'alice@payee.example', {
      amountMsat: 21_000,
      kit: { fetch: payeeFetch },
      poll: { intervalMs: 10, intervalCapMs: 50, maxWaitMs: 5_000 },
    });
    expect(result.outcome).toBe('settled');
    expect(result.invoice).toMatch(/^lnbc/);
    expect(payer.state.noteState(secret('31'))).toBe('burned');
  });

  it('carves the exact amount out of a larger note before melting', async () => {
    const instance = await mint();
    const bearer = await makeBearer(instance, secret('32'), 50_000);
    const result = await payWithBearers([bearer], 'lnbc210n1pjqrstuvwxyz', {
      poll: { intervalMs: 10, intervalCapMs: 50, maxWaitMs: 5_000 },
      allocateOutputSecrets,
      onCarve: () => undefined,
    });
    expect(result.outcome).toBe('settled');
    expect(instance.state.noteState(secret('32'))).toBe('burned');
    expect(result.carve.consumed.map((entry) => entry.id)).toEqual([bearer.id]);
    expect(result.carve.change?.amount).toBe(29_000);
    const change = requiredValue(result.carve.change);
    expect(instance.state.noteState(requiredValue(noteK1(change.url)))).toBe('outstanding');
  });

  it('classifies a failed melt as funds-returned once the note is spendable again', async () => {
    const instance = await mint({ meltAlwaysFails: true });
    const bearer = await makeBearer(instance, secret('33'), 21_000);
    const result = await payWithBearers([bearer], 'lnbc210n1pjqrstuvwxyz', {
      poll: { intervalMs: 10, intervalCapMs: 20, maxWaitMs: 300 },
      allocateOutputSecrets,
      onReturnReady: () => undefined,
    });
    expect(result.outcome).toBe('failed-funds-returned');
    expect(instance.state.noteState(secret('33'))).toBe('burned');
    const rotatedNote = requiredValue(result.rotatedNote);
    expect(rotatedNote.verified).toBe(true);
    expect(instance.state.noteState(requiredValue(noteK1(rotatedNote.url)))).toBe('outstanding');
  });

  it('waits for durable recovery-secret staging before rotating returned funds', async () => {
    const instance = await mint({ meltAlwaysFails: true });
    const bearer = await makeBearer(instance, secret('39'), 21_000);
    let releaseStage: (() => void) | undefined;
    const stageGate = new Promise<void>((resolve) => {
      releaseStage = resolve;
    });
    let stageStarted: (() => void) | undefined;
    const stageEntered = new Promise<void>((resolve) => {
      stageStarted = resolve;
    });
    const payment = payWithBearers([bearer], 'lnbc210n1pjqrstuvwxyz', {
      poll: { intervalMs: 10, intervalCapMs: 20, maxWaitMs: 300 },
      allocateOutputSecrets,
      onReturnReady: async () => {
        stageStarted?.();
        await stageGate;
      },
    });

    await stageEntered;
    expect(instance.state.noteState(secret('39'))).toBe('outstanding');
    releaseStage?.();
    expect((await payment).outcome).toBe('failed-funds-returned');
    expect(instance.state.noteState(secret('39'))).toBe('burned');
  });

  it('classifies a never-settling melt as unknown-still-pending', async () => {
    const instance = await mint({ meltNeverSettles: true });
    const bearer = await makeBearer(instance, secret('34'), 21_000);
    const result = await payWithBearers([bearer], 'lnbc210n1pjqrstuvwxyz', {
      poll: { intervalMs: 10, intervalCapMs: 20, maxWaitMs: 300 },
      allocateOutputSecrets,
      onReturnReady: () => undefined,
    });
    expect(result.outcome).toBe('unknown-still-pending');
    expect(instance.state.noteState(secret('34'))).toBe('pending');
  });

  it('rejects an amountless or unreadable invoice instead of guessing', async () => {
    const instance = await mint();
    const bearer = await makeBearer(instance, secret('35'), 21_000);
    await expect(payWithBearers([bearer], 'lnbc1pjqrstuvwxyz')).rejects.toThrow(/amount/);
    await expect(payWithBearers([bearer], 'not-an-invoice')).rejects.toThrow(/not a valid/i);
  });

  it('aborts before the melt when the carve commit hook fails', async () => {
    const instance = await mint();
    const bearer = await makeBearer(instance, secret('36'), 21_000);
    // paying 10_500 off a 21_000 note forces a split, which must commit
    // through the hook before the melt may start
    await expect(
      payWithBearers([bearer], 'lnbc105n1pjqrstuvwxyz', {
        allocateOutputSecrets,
        onCarve: () => {
          throw new Error('commit failed');
        },
      }),
    ).rejects.toThrow(/commit failed/);
    // The checkpoint failed before either split or melt reached the mint.
    expect(instance.state.noteState(secret('36'))).toBe('outstanding');
    expect([...instance.state.notes.values()].every((note) => note.state !== 'pending')).toBe(true);
  });

  it('draws the return recovery secret from the caller allocation path', async () => {
    const instance = await mint({ meltAlwaysFails: true });
    const bearer = await makeBearer(instance, secret('8a'), 21_000);
    const allocations: Array<{ server: string; count: number }> = [];
    const allocated = [secret('8b')];
    const stagedSecrets: string[] = [];

    const result = await payWithBearers([bearer], 'lnbc210n1pjqrstuvwxyz', {
      poll: { intervalMs: 10, intervalCapMs: 20, maxWaitMs: 300 },
      allocateOutputSecrets: (server, count) => {
        allocations.push({ server, count });
        return Promise.resolve(allocated.slice(0, count));
      },
      onReturnReady: (_carve, recoverySecret) => {
        stagedSecrets.push(recoverySecret);
      },
    });

    expect(result.outcome).toBe('failed-funds-returned');
    expect(allocations).toEqual([{ server: `127.0.0.1:${instance.port}`, count: 1 }]);
    expect(stagedSecrets).toEqual(allocated);
    expect(noteK1(requiredValue(result.rotatedNote).url)).toBe(allocated[0]);
  });

  it('allocates nothing while the melt settles cleanly', async () => {
    const instance = await mint();
    const bearer = await makeBearer(instance, secret('8c'), 21_000);
    let allocations = 0;

    const result = await payWithBearers([bearer], 'lnbc210n1pjqrstuvwxyz', {
      poll: { intervalMs: 10, intervalCapMs: 50, maxWaitMs: 5_000 },
      allocateOutputSecrets: () => {
        allocations += 1;
        return Promise.resolve([]);
      },
    });

    expect(result.outcome).toBe('settled');
    expect(allocations).toBe(0);
  });

  it('refuses the return classification without its durable checkpoint', async () => {
    const instance = await mint({ meltAlwaysFails: true });
    const bearer = await makeBearer(instance, secret('8d'), 21_000);

    await expect(
      payWithBearers([bearer], 'lnbc210n1pjqrstuvwxyz', {
        poll: { intervalMs: 10, intervalCapMs: 20, maxWaitMs: 300 },
        allocateOutputSecrets,
      }),
    ).rejects.toBeInstanceOf(PayReturnCheckpointRequiredError);
    // the payment failed and the mint restored the note; the refusal came
    // before the classification rotate, so nothing else moved
    expect(instance.state.noteState(secret('8d'))).toBe('outstanding');
  });

  it('refuses the return classification without an allocation path', async () => {
    const instance = await mint({ meltAlwaysFails: true });
    const bearer = await makeBearer(instance, secret('8e'), 21_000);

    await expect(
      payWithBearers([bearer], 'lnbc210n1pjqrstuvwxyz', {
        poll: { intervalMs: 10, intervalCapMs: 20, maxWaitMs: 300 },
        onReturnReady: () => undefined,
      }),
    ).rejects.toBeInstanceOf(OutputSecretAllocationRequiredError);
    expect(instance.state.noteState(secret('8e'))).toBe('outstanding');
  });
});
