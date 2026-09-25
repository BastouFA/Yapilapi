import React from 'react';
import { render, waitFor, type RenderResult } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import type { MeResponse, SelfUser } from '@yapilapi/api-client';
import { AppProviders } from '../../src/providers';
import { useAuth } from '../../src/auth/AuthProvider';
import { createMemoryTokenStore, type TokenStore } from '../../src/auth/token-store';
import type { Prefs } from '../../src/prefs';
import type { SocketFactory, SocketLike } from '../../src/realtime/client';

export type Reply = { status?: number; json?: unknown; headers?: Record<string, string> };
export type Handler =
  | Reply
  | ((req: {
      path: string;
      query: URLSearchParams;
      method: string;
      body: unknown;
      headers: Record<string, string>;
    }) => Reply | Promise<Reply>);

export type FakeFetch = jest.Mock<Promise<Response>, [string, RequestInit?]> & {
  calls: Array<{
    method: string;
    path: string;
    query: string;
    body: unknown;
    headers: Record<string, string>;
  }>;
};

/** Routes are `"METHOD /path"` strings (exact path) or `[RegExp-on-"METHOD path", handler]`. Unmatched requests answer a JSON 404 and are recorded. */
export function makeFetch(routes: Record<string, Handler>): FakeFetch {
  const calls: FakeFetch['calls'] = [];
  const fn = jest.fn(async (input: string, init?: RequestInit): Promise<Response> => {
    // React Native's URL polyfill does not implement pathname/search, so split by hand.
    const m = /^https?:\/\/[^/]+([^?#]*)(\?[^#]*)?/.exec(input)!;
    const path = m[1]!;
    const search = m[2] ?? '';
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else body = init?.body;
    calls.push({ method, path, query: search, body, headers });
    const key = `${method} ${path}`;
    const h =
      routes[key] ??
      Object.entries(routes).find(
        ([k]) => k.includes('*') && new RegExp(`^${k.replace(/\*/g, '[^/]+')}$`).test(key),
      )?.[1];
    if (!h)
      return new Response(
        JSON.stringify({ error: { code: 'not_found', message: `no fake route for ${key}` } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    const r =
      typeof h === 'function'
        ? await h({ path, query: new URLSearchParams(search), method, body, headers })
        : h;
    if (r.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(r.json ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  });
  return Object.assign(fn, { calls }) as unknown as FakeFetch;
}

export const selfUser = (over: Partial<SelfUser> = {}): SelfUser => ({
  id: '11111111-1111-4111-8111-111111111111',
  email: 'ada@example.com',
  emailVerified: true,
  status: 'active',
  platformRole: 'user',
  ageBand: 'adult',
  locale: 'en',
  timezone: 'UTC',
  mfaEnabled: false,
  deletionScheduledFor: null,
  profile: {
    username: 'ada',
    displayName: 'Ada Obi',
    avatarUrl: null,
    mode: 'personal',
    onboardingCompleted: true,
  },
  ...over,
});
export const meResponse = (over: Partial<SelfUser> = {}): MeResponse => ({
  user: selfUser(over),
  flags: {},
});

export class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}
export const fakeSocketFactory: SocketFactory = (url) => new FakeSocket(url);

export interface RenderOpts {
  fetch: FakeFetch;
  signedIn?: boolean;
  token?: string | null;
  prefs?: Partial<Prefs>;
  tokenStore?: TokenStore;
  queryClient?: QueryClient;
}

const Ready = ({ children, onReady }: { children: React.ReactNode; onReady: () => void }) => {
  const { status } = useAuth();
  React.useEffect(() => {
    if (status !== 'loading') onReady();
  }, [status, onReady]);
  return status === 'loading' ? null : <>{children}</>;
};

export const testQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      mutations: { retry: false, gcTime: Infinity },
    },
  });

/** Renders `ui` inside the real providers, wired to a fake `fetch` and an in-memory token store. Resolves once auth has booted. */
export async function renderApp(
  ui: React.ReactElement,
  o: RenderOpts,
): Promise<RenderResult & { fetch: FakeFetch; client: QueryClient }> {
  const client = o.queryClient ?? testQueryClient();
  const store =
    o.tokenStore ?? createMemoryTokenStore(o.signedIn === false ? null : (o.token ?? 'test-token'));
  let isReady = false;
  const ready = () => {
    isReady = true;
  };
  const utils = render(
    <AppProviders
      fetch={o.fetch as unknown as typeof fetch}
      tokenStore={store}
      persist={false}
      queryClient={client}
      initialPrefs={{ locale: 'en', theme: 'light', ...o.prefs }}
      socketFactory={fakeSocketFactory}
    >
      <Ready onReady={ready}>{ui}</Ready>
    </AppProviders>,
  );
  await waitFor(
    () => {
      if (!isReady) throw new Error('auth still booting');
    },
    { timeout: 4000 },
  );
  return Object.assign(utils, { fetch: o.fetch, client });
}

export const router = () =>
  (globalThis as unknown as { __mockRouter: Record<'push' | 'replace' | 'back', jest.Mock> })
    .__mockRouter;
export const setParams = (p: Record<string, string>) => {
  (globalThis as unknown as { __mockParams: Record<string, string> }).__mockParams = p;
};

import type { Post, PostMedia } from '@yapilapi/api-client';
export const makePost = (over: Partial<Post> = {}): Post => ({
  id: 'post-1',
  author: { id: 'u-2', username: 'bola', displayName: 'Bola A', avatarUrl: null, mode: 'personal' },
  kind: 'text',
  body: 'Hello from Lagos',
  language: 'en',
  visibility: 'public',
  communityId: null,
  eventId: null,
  productId: null,
  placeId: null,
  circleId: null,
  link: null,
  location: null,
  media: [],
  topics: [],
  poll: null,
  counts: { likes: 2, comments: 1, shares: 0, saves: 0, views: 10 },
  viewer: { reaction: null, saved: false, isAuthor: false },
  aiProvenance: null,
  rights: null,
  moderationStatus: 'ok',
  editedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});
export const makeMedia = (over: Partial<PostMedia> = {}): PostMedia =>
  ({
    id: 'm-1',
    kind: 'image',
    url: 'https://cdn.test/a.jpg',
    mimeType: 'image/jpeg',
    width: 800,
    height: 600,
    durationMs: null,
    altText: 'A market stall',
    status: 'ready',
    blurhash: null,
    ...over,
  }) as PostMedia;
