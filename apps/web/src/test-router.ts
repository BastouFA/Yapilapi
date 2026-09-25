import { vi } from 'vitest';

/** Shared fake for `next/navigation` (see test-setup.ts). */
export const routerMock = {
  pathname: '/',
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
};
