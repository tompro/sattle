import { buildNoteUrl, NoteSpentError } from 'lnurlcash-kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as OpsExports from '@/lnurlcash/ops';
import type { NewBearer } from '@/lnurlcash/types';

const mocks = vi.hoisted(() => ({
  addBearers: vi.fn(),
  applyChangeset: vi.fn(),
  notify: vi.fn(),
  receiveBearer: vi.fn(),
  removeNote: vi.fn(),
  routerReplace: vi.fn(),
}));

const source = {
  id: 'source',
  url: buildNoteUrl('https://mint.test/note', '11'.repeat(32), 21_000),
  callback: 'https://mint.test/callback',
  amount: 21_000,
  verified: true,
  mintPubkey: `02${'aa'.repeat(32)}`,
  label: 'Emergency cash',
  createdAt: 1,
  updatedAt: 1,
};

const staged = {
  id: 'staged',
  url: buildNoteUrl('https://mint.test/note', '22'.repeat(32), 21_000),
  callback: source.callback,
  amount: 0,
  verified: false,
  label: source.label,
  pendingMint: {
    refreshSourceBearerId: source.id,
    sourceRecoverySecret: '11'.repeat(32),
  },
  createdAt: 2,
  updatedAt: 2,
};

const wallet = {
  state: 'unlocked' as const,
  pubkey: null,
  bearers: [source],
  beginFundOperation: () => ({ ownerFence: () => undefined, complete: () => undefined }),
  allocateOutputSecrets: vi.fn(),
  addBearers: mocks.addBearers,
  applyChangeset: mocks.applyChangeset,
  commitCarve: vi.fn(),
  finalizeStagedMintOutput: vi.fn(),
  markSpent: vi.fn(),
  removeNote: mocks.removeNote,
  updateBearer: vi.fn(),
};

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: mocks.routerReplace }),
}));

vi.mock('quasar', () => ({
  useQuasar: () => ({ notify: mocks.notify }),
}));

vi.mock('@/stores/wallet', () => ({
  TrustedMintPostCommitError: class TrustedMintPostCommitError extends Error {},
  useWalletStore: () => wallet,
}));

vi.mock('@/stores/activity', () => ({
  useActivityStore: () => ({ log: vi.fn() }),
}));

vi.mock('@/lnurlcash/trustedMints', () => ({
  getTrustedMintVerificationKeys: () => [],
}));

vi.mock('@/lnurlcash/ops', async (importOriginal) => {
  const actual = await importOriginal<typeof OpsExports>();
  return { ...actual, receiveBearer: mocks.receiveBearer };
});

import { useNotesPage } from './useNotesPage';

describe('note refresh persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wallet.bearers = [source];
    mocks.addBearers.mockResolvedValue([staged]);
    mocks.applyChangeset.mockResolvedValue([]);
    mocks.receiveBearer.mockImplementation(
      async (
        _input: string,
        _existing: unknown[],
        options: { stageRotation?: (note: NewBearer) => void | Promise<void> },
      ) => {
        await options.stageRotation?.({
          url: staged.url,
          callback: staged.callback,
          amount: source.amount,
          verified: false,
          pendingMint: { sourceRecoverySecret: '11'.repeat(32) },
        });
        throw new NoteSpentError('Note is spent');
      },
    );
  });

  it('stages at zero with local metadata and atomically retires a definitively dead source', async () => {
    const notes = useNotesPage();

    await notes.refreshNote(source);

    expect(mocks.addBearers).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          amount: 0,
          label: 'Emergency cash',
          pendingMint: expect.objectContaining({ refreshSourceBearerId: source.id }),
        }),
      ],
      expect.any(Function),
    );
    expect(mocks.applyChangeset).toHaveBeenCalledWith(
      { add: [], markSpent: [source.id], remove: [staged.id] },
      expect.any(Function),
    );
    expect(mocks.removeNote).not.toHaveBeenCalled();
  });
});
