import { vi } from 'vitest';

export const lifecycleMocks = {
  disableBiometricUnlock: vi.fn<() => Promise<void>>(),
  restoreFromNostr: vi.fn(),
  startService: vi.fn(),
};
