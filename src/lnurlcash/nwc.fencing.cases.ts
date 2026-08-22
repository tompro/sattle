// Stale-owner fencing end to end: a service accepted work while its owner
// was still installed, and a second tab replaced the saved key AFTER the
// fence's last safe point - mid-melt, past the boundary where aborting is
// no longer possible. What must not happen is any stale-owner WRITE:
// no bearer changeset, no budget debit, no success response.

import {describe, expect, it} from 'vitest'
import {bytesToHex} from '@noble/hashes/utils.js'

import {readNwcConnections} from './nwc'
import {
  methodRequest,
  OTHER_LINKING_KEY,
  OTHER_OWNER_ID,
  OWNER_ID,
  waitFor,
} from './nwc.testProtocol'
import {makeBearer, mint, readResponse, startTestService} from './nwc.testService'

describe('service: post-boundary stale-owner fencing', () => {
  it('makes no stale-owner writes when the saved key is replaced mid-melt', async () => {
    // Given a running service whose next mint call coincides with a second
    // tab installing its own wallet (the first fetch is the melt itself:
    // the exact-match carve performs no mint call of its own)
    const m = await mint()
    let swapped = false
    const swappingFetch: typeof fetch = (input, init) => {
      if (!swapped) {
        swapped = true
        localStorage.setItem(
          'sattle_linking_key',
          JSON.stringify({
            enc: false,
            value: bytesToHex(OTHER_LINKING_KEY),
            ownerId: OTHER_OWNER_ID,
            version: 1,
          }),
        )
      }
      return fetch(input, init)
    }
    const {relay, walletServicePubkey, state, stop} = await startTestService({
      kit: {fetch: swappingFetch},
    })
    state.bearers = [await makeBearer(m, 'd7'.repeat(32), 21_000)]
    const request = methodRequest(walletServicePubkey, 'pay_invoice', {
      invoice: 'lnbc210n1pjqrstuvwxyz',
    })

    // When the pay flows past the irreversible boundary and reaches the
    // first owner-bound persistence (the conservative budget debit)
    relay.emit(request)
    await waitFor(() => state.errors.length > 0)

    // Then the melt genuinely happened (we are past the boundary) ...
    expect(swapped).toBe(true)
    expect(m.state.noteState('d7'.repeat(32))).toBe('burned')
    // ... but nothing under the stale owner moved: no budget debit, no
    // bearer changeset, no success response (the failure surfaced through
    // onError instead)
    expect(readNwcConnections(OWNER_ID)[0]?.spent.msat).toBe(0)
    expect(state.changesets).toEqual([])
    expect(readResponse(relay.published, request.id, 'nip44_v2')).toBeNull()
    await stop()
  })
})
