// Hostile backup merge policy stays separate from live mint transitions:
// local records win, and imported trust starts unlocked and unconfirmed.

import type {TrustedMint} from './trustedMints'
import {isJsonObject} from './jsonParsing'
import {isValidMintPubkey, type MintTransition} from './trustedMintTransitions'

export const mergeMints = (mints: TrustedMint[], incoming: unknown[]): MintTransition<number> => {
  const knownServers = new Set(mints.map((mint) => mint.server))
  const merged = [...mints]
  let added = 0
  for (const mint of incoming) {
    if (
      !isJsonObject(mint) ||
      typeof mint.server !== 'string' ||
      typeof mint.mintPubkey !== 'string' ||
      typeof mint.addedAt !== 'number' ||
      !isValidMintPubkey(mint.mintPubkey)
    ) {
      continue
    }
    if (knownServers.has(mint.server)) continue
    merged.push({
      server: mint.server,
      mintPubkey: mint.mintPubkey.toLowerCase(),
      addedAt: mint.addedAt,
      locked: false,
      unconfirmed: true,
      nodeAlias: typeof mint.nodeAlias === 'string' ? mint.nodeAlias : undefined,
      nodeColor: typeof mint.nodeColor === 'string' ? mint.nodeColor : undefined,
      nodeCapacityMsat:
        typeof mint.nodeCapacityMsat === 'number' ? mint.nodeCapacityMsat : undefined,
      nodeNumChannels: typeof mint.nodeNumChannels === 'number' ? mint.nodeNumChannels : undefined,
      nodeNumPeers: typeof mint.nodeNumPeers === 'number' ? mint.nodeNumPeers : undefined,
      username: typeof mint.username === 'string' ? mint.username : undefined,
    })
    knownServers.add(mint.server)
    added++
  }
  return added === 0
    ? {mints, result: 0, changed: false}
    : {mints: merged, result: added, changed: true}
}
