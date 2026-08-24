// The relay-facing transport for nostr backup, kept injectable so tests
// never touch a network. The default is nostr-tools' SimplePool, imported
// lazily: merely importing the backup module must never open (or even
// reference) a WebSocket.

import type {Filter as NostrFilter} from 'nostr-tools/filter'

import type {NostrEvent} from './events'

export type {NostrFilter}

// publish throws when the event was accepted NOWHERE
export type BackupTransport = {
  publish: (relays: string[], event: NostrEvent) => Promise<void>
  fetch: (relays: string[], filter: NostrFilter) => Promise<NostrEvent[]>
}

export const defaultTransport = async (): Promise<BackupTransport> => {
  const {SimplePool} = await import('nostr-tools/pool')
  const pool = new SimplePool()
  return {
    publish: async (relays, event) => {
      const results = await Promise.allSettled(pool.publish(relays, event))
      // one honest relay keeping the event is enough - addressable events
      // are re-publishable, and the next debounced publish retries anyway
      if (!results.some((r) => r.status === 'fulfilled')) {
        throw new Error('No relay accepted the backup event.')
      }
    },
    fetch: (relays, filter) => pool.querySync(relays, filter),
  }
}
