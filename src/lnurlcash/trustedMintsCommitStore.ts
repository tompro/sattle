// Web Locks serialize registry writers but do not make one renderer's
// localStorage cache current in the next renderer. IndexedDB is the durable,
// cross-context commit mirror used to carry the last completed envelope.

const DATABASE_NAME = 'sattle-storage-coordination'
const DATABASE_VERSION = 1
const STORE_NAME = 'trusted-mints'
const REGISTRY_KEY = 'registry'

let databasePromise: Promise<IDBDatabase> | undefined

export class TrustedMintsCommitStoreError extends Error {
  override readonly name = 'TrustedMintsCommitStoreError'

  constructor(message: string, cause?: unknown) {
    super(message, {cause})
  }
}

const openDatabase = (): Promise<IDBDatabase> => {
  if (databasePromise) return databasePromise
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => {
        database.close()
        databasePromise = undefined
      }
      resolve(database)
    }
    request.onerror = () => {
      databasePromise = undefined
      reject(
        new TrustedMintsCommitStoreError(
          'Unable to open trusted-mint commit storage.',
          request.error,
        ),
      )
    }
    request.onblocked = () => {
      databasePromise = undefined
      reject(new TrustedMintsCommitStoreError('Trusted-mint commit storage upgrade is blocked.'))
    }
  })
  return databasePromise
}

const runRequest = async <T>(
  mode: IDBTransactionMode,
  createRequest: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode, {
      durability: mode === 'readwrite' ? 'strict' : 'default',
    })
    const request = createRequest(transaction.objectStore(STORE_NAME))
    transaction.oncomplete = () => resolve(request.result)
    transaction.onerror = () =>
      reject(
        new TrustedMintsCommitStoreError(
          'Trusted-mint commit storage transaction failed.',
          transaction.error,
        ),
      )
    transaction.onabort = () =>
      reject(
        new TrustedMintsCommitStoreError(
          'Trusted-mint commit storage transaction was aborted.',
          transaction.error,
        ),
      )
  })
}

export const trustedMintsCommitStore = {
  available: (): boolean => typeof indexedDB !== 'undefined',
  read: async (): Promise<string | null> => {
    const value = await runRequest('readonly', (store) => store.get(REGISTRY_KEY))
    if (value === undefined) return null
    if (typeof value !== 'string') {
      throw new TrustedMintsCommitStoreError('Trusted-mint commit storage is malformed.')
    }
    return value
  },
  write: async (raw: string): Promise<void> => {
    await runRequest('readwrite', (store) => store.put(raw, REGISTRY_KEY))
  },
  clear: async (): Promise<void> => {
    await runRequest('readwrite', (store) => store.delete(REGISTRY_KEY))
  },
}
