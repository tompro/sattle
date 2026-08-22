// The per-connection NWC budget: max msat per rolling period, persisted
// in storage/nwcConnections so a restart (or a browser crash mid-session)
// doesn't reset a client's allowance. The service serializes pay_invoice
// per connection through its request queue, which is what makes the
// check + record below atomic enough: no two pays of one connection ever
// run this concurrently.

import type {NwcConnectionRecord} from '../storage/nwcConnections'
import {persistNwcConnection} from '../storage/nwcConnections'

export const budgetRemainingMsat = (record: NwcConnectionRecord, nowMs: number): number => {
  const {maxMsat, periodMs} = record.budget
  if (nowMs - record.spent.periodStart >= periodMs) return maxMsat
  return Math.max(0, maxMsat - record.spent.msat)
}

// rolls the period when it expired, then adds the spend; persists (the
// caller's queue serialized this read-modify-write)
export const recordSpend = (
  ownerId: string,
  record: NwcConnectionRecord,
  amountMsat: number,
  nowMs: number,
): NwcConnectionRecord => {
  const expired = nowMs - record.spent.periodStart >= record.budget.periodMs
  return persistNwcConnection(ownerId, {
    ...record,
    spent: expired
      ? {periodStart: nowMs, msat: amountMsat}
      : {
          periodStart: record.spent.periodStart,
          msat: record.spent.msat + amountMsat,
        },
  })
}
