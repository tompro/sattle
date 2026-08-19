// Shared test scaffolding: an in-memory localStorage (Node has none outside
// a browser) plus the mock-mint helpers every suite uses.

import {vi} from 'vitest'

export class LocalStorageStub {
  private map = new Map<string, string>()
  getItem = (key: string): string | null => this.map.get(key) ?? null
  setItem = (key: string, value: string): void => {
    this.map.set(key, String(value))
  }
  removeItem = (key: string): void => {
    this.map.delete(key)
  }
  clear = (): void => {
    this.map.clear()
  }
  get length(): number {
    return this.map.size
  }
  key = (index: number): string | null => [...this.map.keys()][index] ?? null
}

export const stubLocalStorage = (): LocalStorageStub => {
  const stub = new LocalStorageStub()
  vi.stubGlobal('localStorage', stub)
  return stub
}
