// Output-secret allocation: a mint-touching operation never invents the
// secrets its outputs will live at. It asks the caller's durable allocation
// path (the wallet's BIP-32 counter reservation, see
// stores/walletFunds.ts) for exactly the secrets it is about to stage, at
// the moment the target server is known - before any hash of them can
// reach a mint. The reservation commit (counter bump plus encrypted
// journal record) is what makes a crash between staging and wire safe:
// indices may be burned, never reused, and the staged secrets are
// recoverable from the funds document.
//
// The ops layer stays framework-free: this is just the option type and the
// point-of-use requirement. Tests inject deterministic allocators;
// production callers serve reserveCashIndices-backed secrets.

export type OutputSecretAllocator = (server: string, count: number) => Promise<readonly string[]>

export class OutputSecretAllocationRequiredError extends Error {
  override readonly name = 'OutputSecretAllocationRequiredError'

  constructor() {
    super('This operation requires durably allocated output secrets.')
  }
}

// The one place secrets enter an operation: exactly `count` fresh secrets
// for `server`, or a rejection before anything is staged or sent. A
// short/long/wrong-shaped answer is a caller bug - fail the operation
// rather than stage a note at an unmappable secret.
export const requireOutputSecrets = async (
  allocate: OutputSecretAllocator | undefined,
  server: string,
  count: number,
): Promise<readonly string[]> => {
  if (!allocate) throw new OutputSecretAllocationRequiredError()
  const secrets = await allocate(server, count)
  if (
    secrets.length !== count ||
    secrets.some((secret) => typeof secret !== 'string' || !/^[0-9a-f]{64}$/.test(secret))
  ) {
    throw new Error('The output secret allocation did not match the request.')
  }
  return secrets
}
