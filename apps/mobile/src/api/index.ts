import {
  ApiError,
  createApiClient,
  type ApiClient,
  type ApiClientOptions,
  type FetchLike,
  type Page,
} from '@yapilapi/api-client';
import { createRequester, buildQuery } from '@yapilapi/api-client/http';
import type * as X from './types';

export * from './types';

export interface MobileApiOptions {
  baseUrl: string;
  /** Returns the session token from secure storage (bearer mode). */
  getToken: () => string | null | undefined | Promise<string | null | undefined>;
  onUnauthorized?: (e: ApiError) => void;
  fetch?: FetchLike;
  /** Current UI locale, sent as Accept-Language so the API can localise messages when it learns to. */
  locale?: () => string;
  timeoutMs?: number;
}

/** A local file the user picked (expo-image-picker asset, or a Blob in tests / web). */
export interface UploadFile {
  uri: string;
  name: string;
  mimeType: string;
  size?: number | undefined;
  blob?: Blob | undefined;
}

const enc = encodeURIComponent;
type Sig = { signal?: AbortSignal | undefined };
type PageParams = Sig & { cursor?: string | undefined; limit?: number | undefined };
const pq = (p?: PageParams) => ({ cursor: p?.cursor, limit: p?.limit });

/**
 * The mobile API: everything `@yapilapi/api-client` offers (bearer mode) plus the endpoints the shared client does not
 * cover yet (discover, search, notifications, push tokens, media). Once those move into the shared client this file
 * shrinks to `createApiClient(...)`.
 */
export function createMobileApi(o: MobileApiOptions) {
  const opts: ApiClientOptions = {
    baseUrl: o.baseUrl,
    mode: 'bearer',
    getToken: o.getToken,
    headers: () => ({ 'accept-language': o.locale?.() ?? 'en' }),
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.onUnauthorized ? { onUnauthorized: o.onUnauthorized } : {}),
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
  };
  const client: ApiClient = createApiClient(opts);
  const { request: r } = createRequester(opts);
  const base = o.baseUrl.replace(/\/+$/, '');
  const doFetch: FetchLike = o.fetch ?? ((i, init) => globalThis.fetch(i, init));

  /** Non-JSON requests (multipart, raw chunks): same auth + error mapping as the JSON requester. */
  async function raw<T>(
    method: string,
    path: string,
    init: { body: BodyInit; headers?: Record<string, string>; signal?: AbortSignal | undefined },
  ): Promise<T> {
    const token = await o.getToken();
    const headers: Record<string, string> = { accept: 'application/json', ...(init.headers ?? {}) };
    if (token) headers['authorization'] = `Bearer ${token}`;
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: init.body,
        signal: init.signal,
      });
    } catch (err) {
      if (init.signal?.aborted) throw err;
      throw new ApiError('network_error', 'Could not reach the server', 0, null, {
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const env = (
        json as
          | { error?: { code?: string; message?: string; details?: unknown; requestId?: string } }
          | undefined
      )?.error;
      const ra = Number(res.headers.get('retry-after'));
      const err = new ApiError(
        env?.code ?? 'internal',
        env?.message ?? `Request failed with status ${res.status}`,
        res.status,
        env?.requestId ?? res.headers.get('x-request-id'),
        env?.details,
        Number.isFinite(ra) && ra > 0 ? ra : null,
      );
      if (res.status === 401) o.onUnauthorized?.(err);
      throw err;
    }
    return json as T;
  }

  const discover = {
    trending: (p?: PageParams & { window?: '1h' | '6h' | '24h' | '7d' }) =>
      r<X.TrendingResponse>('GET', '/v1/discover/trending', {
        query: { ...pq(p), window: p?.window },
        signal: p?.signal,
      }),
    people: (p?: PageParams) =>
      r<{ source: string; items: X.SuggestedPerson[]; nextCursor: string | null }>(
        'GET',
        '/v1/discover/people',
        { query: pq(p), signal: p?.signal },
      ),
    suggestedFollows: (topics: string[], limit = 12, s?: Sig) =>
      r<{ basedOn: string[]; source: string; items: X.SuggestedPerson[] }>(
        'GET',
        '/v1/discover/suggested-follows',
        { query: { topics, limit }, signal: s?.signal },
      ),
    communities: (p?: PageParams & { topic?: string }) =>
      r<{ items: X.DiscoverCommunity[]; nextCursor: string | null }>(
        'GET',
        '/v1/discover/communities',
        { query: { ...pq(p), topic: p?.topic }, signal: p?.signal },
      ),
    topics: (limit = 20, s?: Sig) =>
      r<{ items: X.DiscoverTopic[] }>('GET', '/v1/discover/topics', {
        query: { limit },
        signal: s?.signal,
      }),
  };

  const search = {
    query: (q: string, p?: PageParams & { types?: Array<'posts' | 'people' | 'communities'> }) =>
      r<X.SearchResponse>('GET', '/v1/search', {
        query: { q, types: p?.types, ...pq(p) },
        signal: p?.signal,
      }),
    suggest: (q: string, s?: Sig) =>
      r<X.SuggestResponse>('GET', '/v1/search/suggest', {
        query: { q, limit: 8 },
        signal: s?.signal,
      }),
  };

  const notifications = {
    list: (p?: PageParams & { unread?: boolean; category?: string }) =>
      r<Page<X.AppNotification>>('GET', '/v1/notifications', {
        query: { ...pq(p), unread: p?.unread, category: p?.category },
        signal: p?.signal,
      }),
    unreadCount: (s?: Sig) =>
      r<X.NotificationCounts>('GET', '/v1/notifications/unread-count', { signal: s?.signal }),
    markRead: (id: string) => r<void>('POST', `/v1/notifications/${enc(id)}/read`),
    readAll: () => r<{ updated: number }>('POST', '/v1/notifications/read-all', { body: {} }),
    registerPushToken: (token: string, platform: 'ios' | 'android' | 'web') =>
      r<{ id: string }>('POST', '/v1/notifications/push-tokens', {
        body: { token, platform, provider: 'expo' },
      }),
    unregisterPushToken: (token: string) =>
      r<void>('DELETE', '/v1/notifications/push-tokens', { body: { token } }),
    pushTokens: (s?: Sig) =>
      r<{ items: X.PushTokenRow[] }>('GET', '/v1/notifications/push-tokens', { signal: s?.signal }),
  };

  const media = {
    /** Single-request multipart upload (small files, good connections). */
    upload: (
      file: UploadFile,
      extra: {
        altText?: string;
        decorative?: boolean;
        purpose?: 'attachment' | 'public';
        signal?: AbortSignal | undefined;
      } = {},
    ) => {
      const form = new FormData();
      if (extra.altText) form.append('altText', extra.altText);
      if (extra.decorative) form.append('decorative', 'true');
      if (extra.purpose) form.append('purpose', extra.purpose);
      // React Native's FormData streams `{ uri, name, type }` straight from disk without loading it into JS memory.
      if (file.blob) form.append('file', file.blob, file.name);
      else
        form.append('file', {
          uri: file.uri,
          name: file.name,
          type: file.mimeType,
        } as unknown as Blob);
      return raw<X.MediaView>('POST', '/v1/media', { body: form, signal: extra.signal });
    },
    initUpload: (
      i: {
        kind: 'image' | 'video' | 'audio' | 'file';
        size: number;
        sha256: string;
        chunkSize?: number;
        contentType?: string;
        altText?: string;
        purpose?: 'attachment' | 'public';
      },
      s?: Sig,
    ) =>
      r<X.UploadInit>('POST', '/v1/media/uploads', {
        body: { mode: 'chunked', ...i },
        signal: s?.signal,
      }),
    uploadStatus: (id: string, s?: Sig) =>
      r<X.UploadStatus>('GET', `/v1/media/uploads/${enc(id)}`, { signal: s?.signal }),
    putChunk: (id: string, n: number, bytes: Uint8Array, sha256?: string, s?: Sig) =>
      raw<X.ChunkResult>('PUT', `/v1/media/uploads/${enc(id)}/chunks/${n}`, {
        body: bytes as unknown as BodyInit,
        headers: {
          'content-type': 'application/octet-stream',
          ...(sha256 ? { 'x-chunk-sha256': sha256 } : {}),
        },
        signal: s?.signal,
      }),
    complete: (id: string, s?: Sig) =>
      r<X.MediaView>('POST', `/v1/media/uploads/${enc(id)}/complete`, { signal: s?.signal }),
    get: (id: string, s?: Sig) =>
      r<X.MediaView>('GET', `/v1/media/${enc(id)}`, { signal: s?.signal }),
    remove: (id: string) => r<void>('DELETE', `/v1/media/${enc(id)}`),
    setAvatar: (mediaId: string) =>
      r<{ avatarUrl: string }>('PUT', '/v1/profile/avatar', { body: { mediaId } }),
  };

  const privacy = {
    /** Builds the export on the server (one per 24 hours; the password re-authenticates the request). */
    requestExport: (password: string) =>
      r<X.ExportResult>('POST', '/v1/privacy/export', {
        body: { password },
        skipUnauthorizedHook: true,
      }),
    requests: (s?: Sig) =>
      r<{ items: X.PrivacyRequest[] }>('GET', '/v1/privacy/requests', { signal: s?.signal }),
  };

  return {
    ...client,
    discover,
    search,
    notifications,
    media,
    privacy,
    raw,
    baseUrl: base,
    buildQuery,
  };
}

export type MobileApi = ReturnType<typeof createMobileApi>;
export { ApiError, isApiError } from '@yapilapi/api-client';
