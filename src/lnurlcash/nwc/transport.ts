// The relay-facing transport for the NWC service, kept injectable so
// tests never touch a network. Same pattern as nostr/transport.ts: the
// default (nostr-tools' SimplePool) is imported lazily, so merely
// importing the service module never opens (or even references) a
// WebSocket.

import type {Filter as NostrFilter} from 'nostr-tools/filter'

import type {NostrEvent} from './protocol'

export type {NostrFilter}

export type NwcSubscription = {
  close: () => void
}

export type NwcTransport = {
  publish: (relays: string[], event: NostrEvent) => Promise<void>
  subscribe: (
    relays: string[],
    filter: NostrFilter,
    onEvent: (event: NostrEvent) => void,
  ) => NwcSubscription
}

export const defaultNwcTransport = async (): Promise<NwcTransport> => {
  const {SimplePool} = await import('nostr-tools/pool')
  const pool = new SimplePool()
  return {
    publish: async (relays, event) => {
      const results = await Promise.allSettled(pool.publish(relays, event))
      // one honest relay accepting is enough - same rule as the backup
      if (!results.some((r) => r.status === 'fulfilled')) {
        throw new Error('No relay accepted the event.')
      }
    },
    subscribe: (relays, filter, onEvent) => pool.subscribeMany(relays, filter, {onevent: onEvent}),
  }
}
