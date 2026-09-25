import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { routerMock } from './test-router';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// The app router is not mounted in unit tests: give hooks a stable fake (see apps/admin for the same pattern).
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  usePathname: () => routerMock.pathname,
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));
