// The pure half of the NIP-47 wallet service: the request/response event
// codec - validate, decrypt, build, encrypt - with no relay I/O and no
// wallet logic (dispatch lives in service.ts).
//
// Wire shape (NIP-47):
// - the client sends kind 23194, tagged ['p', wallet-service pubkey], its
//   content a JSON {method, params} encrypted to the wallet service with
//   NIP-44 v2 (tag ['encryption', 'nip44_v2']) or legacy NIP-04 (tag
//   ['encryption', 'nip04'], or NO encryption tag at all)
// - the wallet answers with kind 23195, tagged ['p', client pubkey] and
//   ['e', request id], its content a JSON {result_type, error, result}
//   encrypted back with the SAME scheme the request used
// - a kind 13194 replaceable info event advertises the supported methods
//   and encryption schemes

import type {Event as NostrEvent} from 'nostr-tools/core'
import {finalizeEvent, verifyEvent} from 'nostr-tools/pure'
import {encrypt as nip04Encrypt, decrypt as nip04Decrypt} from 'nostr-tools/nip04'
import {v2 as nip44v2} from 'nostr-tools/nip44'

export type {NostrEvent}

export const NWC_REQUEST_KIND = 23194
export const NWC_RESPONSE_KIND = 23195
export const NWC_INFO_KIND = 13194

export const NWC_METHODS = [
  'get_info',
  'get_balance',
  'make_invoice',
  'pay_invoice',
  'lookup_invoice'
] as const

export type NwcMethod = (typeof NWC_METHODS)[number]

export type NwcErrorCode =
  | 'RATE_LIMITED'
  | 'NOT_IMPLEMENTED'
  | 'INSUFFICIENT_BALANCE'
  | 'QUOTA_EXCEEDED'
  | 'RESTRICTED'
  | 'UNAUTHORIZED'
  | 'INTERNAL'
  | 'UNSUPPORTED_ENCRYPTION'
  | 'PAYMENT_FAILED'
  | 'NOT_FOUND'
  | 'OTHER'

export type NwcRequest = {
  method: string
  params: Record<string, unknown>
}

export type NwcResponse = {
  result_type: string
  error: {code: NwcErrorCode; message: string} | null
  result: unknown
}

export const okResult = (method: string, result: unknown): NwcResponse => ({
  result_type: method,
  error: null,
  result
})

export const errResult = (
  method: string,
  code: NwcErrorCode,
  message: string
): NwcResponse => ({
  result_type: method,
  error: {code, message},
  result: null
})

// the two encryption schemes this service speaks; the scheme of a request
// decides the scheme of its response (NIP-47: "Encrypted using the scheme
// requested by the client")
export type NwcEncryption = 'nip44_v2' | 'nip04'

const conversationKey = (
  walletSecretKey: Uint8Array,
  clientPubkey: string
): Uint8Array => nip44v2.utils.getConversationKey(walletSecretKey, clientPubkey)

export const encryptFor = (
  scheme: NwcEncryption,
  walletSecretKey: Uint8Array,
  clientPubkey: string,
  plaintext: string
): string =>
  scheme === 'nip44_v2'
    ? nip44v2.encrypt(plaintext, conversationKey(walletSecretKey, clientPubkey))
    : nip04Encrypt(walletSecretKey, clientPubkey, plaintext)

const decryptFrom = (
  scheme: NwcEncryption,
  walletSecretKey: Uint8Array,
  clientPubkey: string,
  content: string
): string =>
  scheme === 'nip44_v2'
    ? nip44v2.decrypt(content, conversationKey(walletSecretKey, clientPubkey))
    : nip04Decrypt(walletSecretKey, clientPubkey, content)

const tagValue = (event: NostrEvent, name: string): string | undefined =>
  event.tags.find(t => t[0] === name)?.[1]

// The outcome of validating + decrypting a candidate request event:
// - a request to dispatch (encryption scheme carried so the response can
//   mirror it)
// - a respondable failure: the event IS an authorized client's request,
//   but its content can't be had or parsed - the client still gets a
//   well-formed error answer instead of silence
// - null: not ours to answer at all (wrong kind, wrong author, forged
//   signature, expired, undecryptable, or a response event echoed back) -
//   dropped silently, exactly what a relay full of strangers' traffic
//   demands
export type DecryptedNwcRequest =
  | {respond: false; request: NwcRequest; encryption: NwcEncryption}
  | {respond: true; response: NwcResponse; encryption: NwcEncryption}

export const decryptRequest = (
  walletSecretKey: Uint8Array,
  walletServicePubkey: string,
  clientPubkey: string,
  event: NostrEvent,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): DecryptedNwcRequest | null => {
  if (event.kind !== NWC_REQUEST_KIND) return null
  // only the authorized client may talk to this connection, and the
  // request must actually be addressed to it
  if (event.pubkey !== clientPubkey) return null
  if (tagValue(event, 'p') !== walletServicePubkey) return null
  if (!verifyEvent(event)) return null
  // an expired request is ignored, never answered (NIP-47)
  const expiration = tagValue(event, 'expiration')
  if (expiration !== undefined && Number(expiration) < nowSeconds) {
    return null
  }
  // encryption negotiation: no tag means legacy NIP-04 (NIP-47)
  const advertised = tagValue(event, 'encryption')
  let encryption: NwcEncryption
  if (advertised === undefined || advertised === 'nip04') {
    encryption = 'nip04'
  } else if (advertised === 'nip44_v2') {
    encryption = 'nip44_v2'
  } else {
    // the client asked for a scheme we don't speak - answer in the
    // legacy default, the one scheme every NIP-47 client must read
    return {
      respond: true,
      encryption: 'nip04',
      response: errResult(
        '',
        'UNSUPPORTED_ENCRYPTION',
        `Unsupported encryption scheme: ${advertised}.`
      )
    }
  }
  let plaintext: string
  try {
    plaintext = decryptFrom(encryption, walletSecretKey, clientPubkey, event.content)
  } catch {
    // undecryptable - indistinguishable from relay noise; stay silent
    return null
  }
  let data: unknown
  try {
    data = JSON.parse(plaintext)
  } catch {
    return {
      respond: true,
      encryption,
      response: errResult('', 'OTHER', 'The request is not valid JSON.')
    }
  }
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof (data as NwcRequest).method !== 'string' ||
    (data as NwcRequest).method === ''
  ) {
    return {
      respond: true,
      encryption,
      response: errResult('', 'OTHER', 'The request has no method.')
    }
  }
  const request = data as NwcRequest
  const params =
    typeof request.params === 'object' && request.params !== null
      ? request.params
      : {}
  return {respond: false, request: {method: request.method, params}, encryption}
}

// signs the kind-23195 answer to a request, mirroring its encryption
// scheme and referencing it via the 'e' tag
export const buildResponseEvent = (
  walletSecretKey: Uint8Array,
  clientPubkey: string,
  encryption: NwcEncryption,
  requestEventId: string,
  response: NwcResponse,
  createdAt: number = Math.floor(Date.now() / 1000)
): NostrEvent =>
  finalizeEvent(
    {
      kind: NWC_RESPONSE_KIND,
      created_at: createdAt,
      tags: [
        ['p', clientPubkey],
        ['e', requestEventId],
        ['encryption', encryption]
      ],
      content: encryptFor(
        encryption,
        walletSecretKey,
        clientPubkey,
        JSON.stringify(response)
      )
    },
    walletSecretKey
  )

// the replaceable info event advertising this service's capabilities
export const buildInfoEvent = (
  walletSecretKey: Uint8Array,
  createdAt: number = Math.floor(Date.now() / 1000)
): NostrEvent =>
  finalizeEvent(
    {
      kind: NWC_INFO_KIND,
      created_at: createdAt,
      tags: [['encryption', 'nip44_v2 nip04']],
      content: NWC_METHODS.join(' ')
    },
    walletSecretKey
  )
