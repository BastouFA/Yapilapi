import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { routerMock } from './test-router';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// jsdom lacks these; components use them defensively but tests should not crash.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView)
  Element.prototype.scrollIntoView = () => undefined;
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// The app router is not mounted in unit tests: give hooks a stable fake.
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  usePathname: () => routerMock.pathname,
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));
