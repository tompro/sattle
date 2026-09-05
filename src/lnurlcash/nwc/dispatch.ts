// Method dispatch: get_info / get_balance / make_invoice /
// lookup_invoice live here directly, pay_invoice in pay.ts (it carries
// the budget logic). Bearers always come IN through deps.getBearers and
// results go OUT through deps.applyChangeset - this engine never touches
// wallet state itself.

import { noteK1, sameInvoice } from 'lnurlcash-kit';

import type { Bearer } from '../types';
import type { PreparedMint } from '../ops';
import { prepareMint } from '../ops';
import { PollAbortedError } from '../ops/shared';

import type { PendingInvoice, RequestContext } from './context';
import { invoiceResult, invoiceRetireAfter, resolvePaymentHash, settleAndClaim } from './invoices';
import { handlePayInvoice } from './pay';
import type { NwcRequest, NwcResponse } from './protocol';
import { NWC_METHODS, errResult, okResult } from './protocol';

const MAX_PENDING_MINT_OUTPUTS = 20;

// the same eligibility carve applies - the balance answers "what could
// this wallet actually pay with right now"
const spendable = (bearer: Bearer): boolean =>
  !bearer.spent && bearer.callback !== '' && !bearer.deviceId && !!noteK1(bearer.url);

const handleGetInfo = (ctx: RequestContext): NwcResponse =>
  okResult('get_info', {
    alias: 'sattle',
    color: '#55ffcc',
    pubkey: ctx.connection().walletServicePubkey,
    // a bearer-note wallet has no chain view of its own - the network is
    // whatever the mints' invoices say, mainnet in practice. No honest
    // block height/hash exists, so those fields are simply absent.
    network: 'mainnet',
    methods: [...NWC_METHODS],
    notifications: [],
  });

const handleGetBalance = (ctx: RequestContext): NwcResponse =>
  okResult('get_balance', {
    balance: ctx.deps
      .getBearers()
      .filter(spendable)
      .reduce((sum, b) => sum + b.amount, 0),
  });

const handleMakeInvoice = async (
  ctx: RequestContext,
  params: Record<string, unknown>,
): Promise<NwcResponse> => {
  const amountMsat = Number(params.amount);
  if (!Number.isInteger(amountMsat) || amountMsat <= 0) {
    return errResult('make_invoice', 'OTHER', 'Amount must be a positive whole number of msat.');
  }
  const mint = ctx.deps.getDefaultMint();
  if (!mint) {
    return errResult('make_invoice', 'INTERNAL', 'No default mint is configured.');
  }
  const now = ctx.nowSeconds();
  if (
    ctx.deps
      .getBearers()
      .some(
        (bearer) =>
          !bearer.spent &&
          bearer.pendingMint?.retireAfter !== undefined &&
          bearer.pendingMint.retireAfter <= now,
      )
  ) {
    await ctx.deps.recoverPendingMints(ctx.assertOwner);
  }
  const pendingOutputs = ctx.deps
    .getBearers()
    .filter((bearer) => bearer.pendingMint && !bearer.spent).length;
  if (pendingOutputs >= MAX_PENDING_MINT_OUTPUTS) {
    return errResult('make_invoice', 'QUOTA_EXCEEDED', 'Too many unpaid invoices are pending.');
  }
  let prepared: PreparedMint;
  let stagedOutput: Bearer | undefined;
  try {
    prepared = await prepareMint(mint, amountMsat, {
      ...(ctx.deps.kit ?? {}),
      assertOwner: ctx.assertOwner,
      allocateOutputSecrets: (server, count) =>
        ctx.deps.allocateOutputSecrets(server, count, ctx.assertOwner),
      persistOutput: async (note) => {
        stagedOutput = await ctx.deps.persistMintOutput(note, ctx.assertOwner);
      },
    });
  } catch (err) {
    if (stagedOutput) {
      try {
        await ctx.deps.discardMintOutput(stagedOutput, ctx.assertOwner);
      } catch (cleanupError) {
        return errResult(
          'make_invoice',
          'INTERNAL',
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        );
      }
    }
    return errResult('make_invoice', 'INTERNAL', err instanceof Error ? err.message : String(err));
  }
  if (!stagedOutput) {
    return errResult('make_invoice', 'INTERNAL', 'The pending mint output was not persisted.');
  }
  const retireAfter = invoiceRetireAfter(prepared.invoice);
  if (retireAfter !== null) {
    try {
      await ctx.deps.setMintOutputRetirement(stagedOutput, retireAfter, ctx.assertOwner);
    } catch (error) {
      try {
        await ctx.deps.discardMintOutput(stagedOutput, ctx.assertOwner);
      } catch (cleanupError) {
        return errResult(
          'make_invoice',
          'INTERNAL',
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        );
      }
      return errResult(
        'make_invoice',
        'INTERNAL',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const entry: PendingInvoice = {
    invoice: prepared.invoice,
    paymentHash: resolvePaymentHash(prepared),
    amountMsat: prepared.grossMsat,
    createdAt: ctx.nowSeconds(),
    prepared,
    stagedOutput,
    state: 'pending',
  };
  if (typeof params.description === 'string' && params.description) {
    entry.description = params.description;
  }
  const expiry = Number(params.expiry);
  if (Number.isInteger(expiry) && expiry > 0) {
    entry.expiresAt = entry.createdAt + expiry;
  }
  ctx.invoices.set(entry.paymentHash, entry);
  // phase two runs in the background; the invoice goes out now and
  // lookup_invoice reports the settlement the service-owned claim observes
  const started = ctx.startBackground(() =>
    settleAndClaim(ctx, entry).catch((err) => {
      entry.state = 'failed';
      // an interrupted claim poll is normal service teardown (stop
      // aborted it), not a background failure worth surfacing
      if (err instanceof PollAbortedError) return;
      ctx.deps.onError?.(err, ctx.connection());
    }),
  );
  if (!started) {
    entry.state = 'failed';
    return errResult('make_invoice', 'INTERNAL', 'The wallet service is stopping.');
  }
  return okResult('make_invoice', invoiceResult(entry));
};

const handleLookupInvoice = (ctx: RequestContext, params: Record<string, unknown>): NwcResponse => {
  const invoiceParam = typeof params.invoice === 'string' ? params.invoice : undefined;
  const hashParam =
    typeof params.payment_hash === 'string' ? params.payment_hash.toLowerCase() : undefined;
  if (!invoiceParam && !hashParam) {
    return errResult('lookup_invoice', 'OTHER', 'Provide an invoice or a payment hash.');
  }
  let entry = hashParam ? ctx.invoices.get(hashParam) : undefined;
  if (!entry && invoiceParam) {
    for (const candidate of ctx.invoices.values()) {
      if (sameInvoice(candidate.invoice, invoiceParam)) {
        entry = candidate;
        break;
      }
    }
  }
  if (!entry) {
    return errResult('lookup_invoice', 'NOT_FOUND', 'Unknown invoice.');
  }
  return okResult('lookup_invoice', invoiceResult(entry));
};

export const dispatch = async (ctx: RequestContext, request: NwcRequest): Promise<NwcResponse> => {
  switch (request.method) {
    case 'get_info':
      return handleGetInfo(ctx);
    case 'get_balance':
      return handleGetBalance(ctx);
    case 'make_invoice':
      return await handleMakeInvoice(ctx, request.params);
    case 'pay_invoice':
      return await handlePayInvoice(ctx, request.params);
    case 'lookup_invoice':
      return handleLookupInvoice(ctx, request.params);
    default:
      return errResult(request.method, 'NOT_IMPLEMENTED', `Unknown method: ${request.method}.`);
  }
};
