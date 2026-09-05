import { describe, expect, it } from 'vitest';
import { noteK1 } from 'lnurlcash-kit';

import type { CarveResult } from './ops';
import { ensureExactAmount, receiveBearer } from './ops';
import { requiredValue } from './test-utils';
import {
  allocateOutputSecrets,
  makeBearer,
  mint,
  noteUrl,
  retryingCbFetch,
  secret,
  stageRotation,
} from './ops.testHarness';

// The redeem callback is a GET, and HTTP stacks retry GETs - so a mint
// can execute the first attempt of a mutation and refuse the byte-identical
// repeat as an already-spent input, which is the only answer the wallet
// ever sees. Every mutation that carries fresh secrets must probe the
// would-be outputs before believing such a refusal: landed means the
// carried secrets are the only money left.
describe('mutation retry refusals', () => {
  it('rescues the outputs when the split answer is a retry refusal', async () => {
    const instance = await mint();
    const k1 = secret('60');
    const bearer = await makeBearer(instance, k1, 50_000);
    const result = await ensureExactAmount([bearer], 25_000, {
      fetch: retryingCbFetch(),
      allocateOutputSecrets,
      onCarve: () => undefined,
    });
    // the split landed on the first (unseen) attempt: the input is burned
    // and both outputs are live under the secrets the wallet carried
    expect(instance.state.noteState(k1)).toBe('burned');
    expect(result.consumed).toHaveLength(1);
    const partK1 = requiredValue(noteK1(result.note.url));
    expect(partK1).not.toBe(k1);
    expect(result.note.amount).toBe(25_000);
    expect(instance.state.noteState(partK1)).toBe('outstanding');
    const changeK1 = requiredValue(noteK1(requiredValue(result.change).url));
    expect(instance.state.noteState(changeK1)).toBe('outstanding');
  });

  it('rescues the combined note when the merge answer is a retry refusal', async () => {
    const instance = await mint();
    const a = await makeBearer(instance, secret('61'), 20_000);
    const b = await makeBearer(instance, secret('62'), 5_000);
    const result = await ensureExactAmount([a, b], 25_000, {
      fetch: retryingCbFetch(),
      allocateOutputSecrets,
      onCarve: () => undefined,
    });
    expect(result.consumed).toHaveLength(2);
    expect(instance.state.noteState(secret('61'))).toBe('burned');
    expect(instance.state.noteState(secret('62'))).toBe('burned');
    const mergedK1 = requiredValue(noteK1(result.note.url));
    expect(result.note.amount).toBe(25_000);
    expect(instance.state.noteState(mergedK1)).toBe('outstanding');
  });

  it('adopts the fresh secret when the receive rotate answer is a retry refusal', async () => {
    const instance = await mint();
    const senderK1 = secret('63');
    instance.state.creditNote(senderK1, 21_000);
    const received = await receiveBearer(noteUrl(instance, senderK1, 21_000), [], {
      fetch: retryingCbFetch(),
      allocateOutputSecrets,
      stageRotation,
    });
    expect(received.rotated).toBe(true);
    expect(received.note.amount).toBe(21_000);
    expect(instance.state.noteState(senderK1)).toBe('burned');
    const k1 = requiredValue(noteK1(received.note.url));
    expect(k1).not.toBe(senderK1);
    expect(instance.state.noteState(k1)).toBe('outstanding');
  });

  it('still fails a genuine refusal - a note spent before the split', async () => {
    const instance = await mint();
    const k1 = secret('64');
    const bearer = await makeBearer(instance, k1, 50_000);
    instance.state.settleMelt(k1); // burned elsewhere, before we ever asked
    const checkpoints: CarveResult[] = [];
    await expect(
      ensureExactAmount([bearer], 25_000, {
        fetch: retryingCbFetch(),
        allocateOutputSecrets,
        onCarve: (carve) => {
          checkpoints.push(carve);
        },
      }),
    ).rejects.toThrow(/spent/i);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]?.consumed).toEqual([]);
  });
});
