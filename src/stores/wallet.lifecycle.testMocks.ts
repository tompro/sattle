import { vi } from 'vitest';

export const lifecycleMocks = {
  disableBiometricUnlock: vi.fn<() => Promise<void>>(),
  unlockWalletMaterialWithBiometrics: vi.fn(),
  unlockWalletMaterialWithPasskey: vi.fn(),
  restoreFromNostr: vi.fn(),
  startService: vi.fn(),
};
