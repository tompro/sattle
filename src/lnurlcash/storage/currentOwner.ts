// Mutators must not let a still-running old tab overwrite namespaces after a
// successor has installed its saved-key owner marker. Ownerless data may only
// move through explicit migration APIs after their own proof checks succeed.

import {savedKeyOwnerId} from '../keys'

export class WalletOwnerMismatchError extends Error {
  override readonly name = 'WalletOwnerMismatchError'
  constructor() {
    super('The active wallet owner no longer matches the saved wallet.')
  }
}

export const savedKeyOwnerAllows = (ownerId: string): boolean => {
  return savedKeyOwnerId() === ownerId
}

export const assertSavedKeyOwner = (ownerId: string): void => {
  if (!savedKeyOwnerAllows(ownerId)) throw new WalletOwnerMismatchError()
}
