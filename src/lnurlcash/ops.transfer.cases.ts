import { describe, expect, it } from 'vitest';
import { createMockMint } from 'lnurlcash-conformance/mock-mint';
import { hashK1, noteK1 } from 'lnurlcash-kit';

import { transferBetweenMints as transferBetweenMintsEngine } from './ops';
import { OutputSecretAllocationRequiredError, TransferMeltCheckpointRequiredError } from './ops';
import type { CarveResult, TransferOptions } from './ops';
import type { Bearer } from './types';
import { requiredValue } from './test-utils';
import {
  allocateOutputSecrets,
  expectBurned,
  makeBearer,
  mint,
  persistOutput,
  secret,
  settleWhenRequested,
} from './ops.testHarness';

const transferBetweenMints = (
  bearers: Bearer[],
  amountMsat: number,
  targetMint: string,
  options: Omit<TransferOptions, 'persistOutput'> = {},
) =>
  transferBetweenMintsEngine(bearers, amountMsat, targetMint, {
    allocateOutputSecrets,
    onMeltReady: () => undefined,
    ...options,
    persistOutput,
  });

describe('transferBetweenMints', () => {
  const fastPoll = { intervalMs: 10, intervalCapMs: 50, maxWaitMs: 5_000 };

  it('draws the target and source secrets from the caller allocation path', async () => {
    const source = await mint();
    const target = await mint({ testHooks: true });
    const bearer = await makeBearer(source, secret('91'), 21_000);
    const targetSecret = secret('92');
    const sourceRecoverySecret = secret('93');
    const allocations: Array<{ server: string; count: number }> = [];
    const meltReadiness: string[] = [];

    const pending = transferBetweenMints([bearer], 21_000, `mint@127.0.0.1:${target.port}`, {
      poll: fastPoll,
      allocateOutputSecrets: (server, count) => {
        allocations.push({ server, count });
        const secrets = allocations.length === 1 ? [targetSecret] : [sourceRecoverySecret];
        return Promise.resolve(secrets.slice(0, count));
      },
      onMeltReady: (_carve, recovery) => {
        meltReadiness.push(recovery);
      },
    });
    await settleWhenRequested(target);
    const result = await pending;

    expect(result.outcome).toBe('settled');
    // the staged target note first, then the source recovery secret - an
    // exact source carve allocates nothing
    expect(allocations).toEqual([
      { server: `127.0.0.1:${target.port}`, count: 1 },
      { server: `127.0.0.1:${source.port}`, count: 1 },
    ]);
    expect(meltReadiness).toEqual([sourceRecoverySecret]);
    expect(noteK1(requiredValue(result.mintedAtTarget).note.url)).toBe(targetSecret);
  });

  it('refuses the source melt without its durable checkpoint', async () => {
    const source = await mint();
    const target = await mint({ testHooks: true });
    const bearer = await makeBearer(source, secret('98'), 21_000);

    await expect(
      transferBetweenMintsEngine([bearer], 21_000, `mint@127.0.0.1:${target.port}`, {
        allocateOutputSecrets,
        persistOutput,
      }),
    ).rejects.toBeInstanceOf(TransferMeltCheckpointRequiredError);

    // the target stage happened (invoice exists) but the source note is
    // untouched and nothing melted
    expect(source.state.noteState(secret('98'))).toBe('outstanding');
  });

  it('refuses at target staging without an allocation path', async () => {
    const source = await mint();
    const target = await mint({ testHooks: true });
    const bearer = await makeBearer(source, secret('99'), 21_000);

    await expect(
      transferBetweenMintsEngine([bearer], 21_000, `mint@127.0.0.1:${target.port}`, {
        onMeltReady: () => undefined,
        persistOutput,
      }),
    ).rejects.toBeInstanceOf(OutputSecretAllocationRequiredError);
    expect(source.state.noteState(secret('99'))).toBe('outstanding');
  });

  it('moves value to another mint at a wallet-chosen target secret', async () => {
    const source = await mint();
    const target = await mint({ testHooks: true });
    const k1 = secret('40');
    const bearer = await makeBearer(source, k1, 21_000);
    const pending = transferBetweenMints([bearer], 21_000, `mint@127.0.0.1:${target.port}`, {
      poll: fastPoll,
    });
    const preimage = await settleWhenRequested(target);
    const result = await pending;
    expect(result.outcome).toBe('settled');
    expect(result.invoice).toMatch(/^lnbc/);
    expect(result.quote).toEqual({
      requestedMsat: 21_000,
      grossMsat: 21_000,
      targetMintFeeMsat: 0,
      sourceMeltFeeReserveMsat: 0,
    });
    expect(result.sourceServer).not.toBe(result.targetServer);
    await expectBurned(source, k1);
    const claimed = requiredValue(result.mintedAtTarget);
    expect(claimed.note.amount).toBe(21_000);
    expect(claimed.note.verified).toBe(true);
    expect(target.state.noteState(preimage)).toBeNull();
    const newK1 = requiredValue(noteK1(claimed.note.url));
    expect(newK1).not.toBe(preimage);
    expect(target.state.noteState(newK1)).toBe('outstanding');
  });

  it('refuses an amount no source mint can cover', async () => {
    const source = await mint();
    const target = await mint();
    const k1 = secret('41');
    const bearer = await makeBearer(source, k1, 5_000);
    let persisted = false;
    await expect(
      transferBetweenMintsEngine([bearer], 50_000, `mint@127.0.0.1:${target.port}`, {
        persistOutput: () => {
          persisted = true;
        },
      }),
    ).rejects.toThrow(/enough/);
    expect(persisted).toBe(false);
    expect(source.state.noteState(k1)).toBe('outstanding');
  });

  it('refuses an invoice the single selected note cannot cover, even when its mint holds more', async () => {
    const source = await mint();
    const target = await mint();
    const selectedK1 = secret('55');
    const untappedK1 = secret('56');
    // the move page's selected-note constraint: the engine's source list is
    // ONLY the picked note, so the sibling note at the same mint must not
    // top the amount up
    const selected = await makeBearer(source, selectedK1, 5_000);
    await makeBearer(source, untappedK1, 50_000);
    let persisted = false;
    await expect(
      transferBetweenMintsEngine([selected], 21_000, `mint@127.0.0.1:${target.port}`, {
        persistOutput: () => {
          persisted = true;
        },
      }),
    ).rejects.toThrow(/enough/);
    expect(persisted).toBe(false);
    expect(source.state.noteState(selectedK1)).toBe('outstanding');
    expect(source.state.noteState(untappedK1)).toBe('outstanding');
  });

  it('rejects a transfer onto the mint the notes are already on', async () => {
    const instance = await mint();
    const k1 = secret('42');
    const bearer = await makeBearer(instance, k1, 21_000);
    await expect(
      transferBetweenMints([bearer], 21_000, `mint@127.0.0.1:${instance.port}`),
    ).rejects.toThrow(/different target/);
    expect(instance.state.noteState(k1)).toBe('outstanding');
  });

  it('moves nothing when the target mint is unreachable', async () => {
    const source = await mint();
    const dead = await createMockMint();
    const deadAddress = `mint@127.0.0.1:${dead.port}`;
    await dead.close();
    const k1 = secret('43');
    const bearer = await makeBearer(source, k1, 50_000);
    await expect(transferBetweenMints([bearer], 21_000, deadAddress)).rejects.toThrow();
    expect(source.state.noteState(k1)).toBe('outstanding');
  });

  it('reports a definitively spent source before waiting on the target', async () => {
    const source = await mint();
    const target = await mint();
    const k1 = secret('54');
    const bearer = await makeBearer(source, k1, 21_000);
    source.state.settleMelt(k1);

    const result = await transferBetweenMints([bearer], 21_000, `mint@127.0.0.1:${target.port}`);

    expect(result.outcome).toBe('note-already-spent');
  });

  it('recovers from a melt whose answer was lost once the target invoice settles', async () => {
    const source = await mint({ unconfirmedMutation: true });
    const target = await mint({ testHooks: true });
    const k1 = secret('44');
    const bearer = await makeBearer(source, k1, 21_000);
    const pending = transferBetweenMints([bearer], 21_000, `mint@127.0.0.1:${target.port}`, {
      poll: fastPoll,
    });
    await settleWhenRequested(target);
    const result = await pending;
    expect(result.outcome).toBe('settled');
    await expectBurned(source, k1);
    expect(result.mintedAtTarget?.note.amount).toBe(21_000);
  });

  it('grosses the carve up for the target mint fee, refusing when only the net is covered', async () => {
    const source = await mint();
    const target = await mint({ baseFeeMsat: 1_000, feePpm: 2_000 });
    const k1 = secret('46');
    const bearer = await makeBearer(source, k1, 100_000);
    await expect(
      transferBetweenMints([bearer], 100_000, `mint@127.0.0.1:${target.port}`),
    ).rejects.toThrow(/enough/);
    expect(source.state.noteState(k1)).toBe('outstanding');
  });

  it('restores the source note, re-secured, when the melt fails', async () => {
    const source = await mint({ meltAlwaysFails: true });
    const target = await mint({ testHooks: true });
    const k1 = secret('47');
    const bearer = await makeBearer(source, k1, 21_000);
    const result = await transferBetweenMints([bearer], 21_000, `mint@127.0.0.1:${target.port}`, {
      poll: { intervalMs: 10, intervalCapMs: 20, maxWaitMs: 300 },
    });
    expect(result.outcome).toBe('failed-funds-returned');
    expect(result.mintedAtTarget).toBeUndefined();
    expect(source.state.noteState(k1)).toBe('burned');
    // the returned funds come back re-secured at the source-probe rotate's
    // fresh secret - carried as rotatedNote, NOT folded into the carve
    // (which an onCarve checkpoint may already have committed)
    const rotatedNote = requiredValue(result.rotatedNote);
    expect(rotatedNote.verified).toBe(true);
    const returnedK1 = requiredValue(noteK1(rotatedNote.url));
    expect(returnedK1).not.toBe(k1);
    expect(source.state.noteState(returnedK1)).toBe('outstanding');
    expect(rotatedNote.amount).toBe(21_000);
  });

  it('lands the target note at the staged wallet secret without rotating', async () => {
    const source = await mint();
    const target = await mint({ testHooks: true });
    const k1 = secret('48');
    const bearer = await makeBearer(source, k1, 21_000);
    const pending = transferBetweenMints([bearer], 21_000, `mint@127.0.0.1:${target.port}`, {
      poll: fastPoll,
    });
    const preimage = await settleWhenRequested(target);
    const result = await pending;
    expect(result.outcome).toBe('settled');
    await expectBurned(source, k1);
    const claimed = requiredValue(result.mintedAtTarget);
    expect(claimed.note.amount).toBe(21_000);
    expect(claimed.note.verified).toBe(true);
    const newK1 = requiredValue(noteK1(claimed.note.url));
    // the note stands at the wallet's own secret - the quote was bound to
    // its hash, and the payment preimage keys nothing at the target
    expect([...target.state.invoices.values()].at(-1)?.boundTo).toBe(hashK1(newK1));
    expect(target.state.noteState(newK1)).toBe('outstanding');
    expect(target.state.noteState(preimage)).toBeNull();
  });

  it('keeps the named claim material when the target never credits the note', async () => {
    const source = await mint({ meltNeverSettles: true });
    const target = await mint({ testHooks: true });
    const k1 = secret('49');
    const bearer = await makeBearer(source, k1, 21_000);
    const pending = transferBetweenMints([bearer], 21_000, `mint@127.0.0.1:${target.port}`, {
      poll: { intervalMs: 10, intervalCapMs: 20, maxWaitMs: 300 },
    });
    // the target invoice exists (the quote is bound) but the source melt
    // never lands, so nothing is ever credited at the wallet's secret
    while (target.state.invoices.size === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const result = await pending;
    expect(result.outcome).toBe('unknown-still-pending');
    expect(result.mintedAtTarget).toBeUndefined();
    // the wallet's secret is the way back to the money if the melt's
    // payment arrives later - and the note at that secret is tracked
    // unverified, so a late settlement is never a lost note
    const noteSecret = requiredValue(result.claimMaterial?.noteSecret);
    expect(noteSecret).toMatch(/^[0-9a-f]{64}$/);
    const material = requiredValue(result.claimMaterial?.note);
    expect(material.verified).toBe(false);
    expect(noteK1(material.url)).toBe(noteSecret);
  });

  it('fires onCarve before the carve or melt reaches the mint', async () => {
    const source = await mint();
    const target = await mint({ testHooks: true });
    const bearer = await makeBearer(source, secret('51'), 21_000);
    const seen: CarveResult[] = [];
    const pending = transferBetweenMints([bearer], 10_000, `mint@127.0.0.1:${target.port}`, {
      poll: fastPoll,
      onCarve: (carve) => {
        seen.push(carve);
        if (carve.consumed.length === 0) {
          expect(source.state.noteState(requiredValue(noteK1(carve.note.url)))).toBeNull();
          expect(source.state.noteState(requiredValue(noteK1(bearer.url)))).toBe('outstanding');
        } else {
          expect(source.state.noteState(requiredValue(noteK1(carve.note.url)))).toBe('outstanding');
          expect(source.state.noteState(requiredValue(noteK1(bearer.url)))).toBe('burned');
        }
      },
    });
    await settleWhenRequested(target);
    const result = await pending;
    expect(result.outcome).toBe('settled');
    expect(seen).toHaveLength(2);
    expect(seen[0]?.consumed).toEqual([]);
    expect(seen[1]?.consumed.map((entry) => entry.id)).toEqual([bearer.id]);
  });

  it('aborts before the melt when the carve commit hook fails', async () => {
    const source = await mint();
    const target = await mint({ testHooks: true });
    const k1 = secret('52');
    const bearer = await makeBearer(source, k1, 21_000);
    await expect(
      transferBetweenMints([bearer], 10_000, `mint@127.0.0.1:${target.port}`, {
        onCarve: () => {
          throw new Error('commit failed');
        },
      }),
    ).rejects.toThrow(/commit failed/);
    // The checkpoint failed before either split or melt reached the source.
    expect(source.state.noteState(k1)).toBe('outstanding');
    expect([...source.state.notes.values()].every((note) => note.state !== 'pending')).toBe(true);
  });

  it('aborts before an exact-note melt when the final checkpoint fails', async () => {
    const source = await mint();
    const target = await mint();
    const k1 = secret('53');
    const bearer = await makeBearer(source, k1, 21_000);

    await expect(
      transferBetweenMints([bearer], 21_000, `mint@127.0.0.1:${target.port}`, {
        onMeltReady: () => {
          throw new Error('source link commit failed');
        },
      }),
    ).rejects.toThrow(/source link commit failed/);

    expect(source.state.noteState(k1)).toBe('outstanding');
  });
});
