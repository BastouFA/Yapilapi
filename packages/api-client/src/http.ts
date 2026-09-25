import { ApiError } from './errors';

export type ClientMode = 'cookie' | 'bearer';
export type QueryValue =
  string | number | boolean | null | undefined | ReadonlyArray<string | number>;
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** e.g. `https://api.yapilapi.example` (no trailing slash needed). */
  baseUrl: string;
  /**
   * `cookie` (browsers): sends the httpOnly session cookie (`credentials: 'include'`) plus the CSRF header.
   * `bearer` (React Native / server-to-server): sends `Authorization: Bearer <token>` and asks the API to deliver tokens.
   */
  mode?: ClientMode;
  /** Bearer mode: return the current session token (from secure storage). Never persist it in localStorage. */
  getToken?: () => string | null | undefined | Promise<string | null | undefined>;
  /** Inject a fetch implementation (tests, SSR cookie forwarding, React Native polyfills). Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Extra headers on every request (e.g. `x-request-id`, `accept-language`, or a forwarded `cookie` for SSR). */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** Abort requests that take longer than this. Default 20s. Use 0 to disable. */
  timeoutMs?: number;
  /** Called for every 401 response (except when `skipUnauthorizedHook` is set on the call). Use it to redirect to sign-in. */
  onUnauthorized?: (error: ApiError) => void;
}

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal | undefined;
  /** Do not fire `onUnauthorized` (used by calls where a 401 is an expected, handled outcome, e.g. login). */
  skipUnauthorizedHook?: boolean;
  /** Extra headers for this call only (e.g. `Idempotency-Key`), merged over the client's global headers. */
  headers?: Record<string, string>;
}

export const CSRF_HEADER = 'x-yl-csrf';
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    const value = Array.isArray(v) ? v.join(',') : String(v);
    if (value === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(value)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

export type Requester = <T>(method: string, path: string, opts?: RequestOptions) => Promise<T>;

export function createRequester(options: ApiClientOptions): {
  request: Requester;
  mode: ClientMode;
} {
  const mode: ClientMode = options.mode ?? 'cookie';
  const base = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 20_000;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const extra = typeof options.headers === 'function' ? options.headers() : options.headers;
    if (extra) Object.assign(headers, extra);
    if (opts.headers) Object.assign(headers, opts.headers);
    // A FormData body (file uploads) sets its own multipart boundary; the browser/runtime must compute that header.
    const isFormData = typeof FormData !== 'undefined' && opts.body instanceof FormData;
    if (opts.body !== undefined && !isFormData) headers['content-type'] = 'application/json';
    if (mode === 'bearer') {
      const token = await options.getToken?.();
      if (token) headers['authorization'] = `Bearer ${token}`;
    } else if (UNSAFE.has(method)) {
      headers[CSRF_HEADER] = '1';
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs)
        : undefined;
    const onAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const init: RequestInit = { method, headers, signal: controller.signal };
    if (mode === 'cookie') init.credentials = 'include';
    if (opts.body !== undefined)
      init.body = isFormData ? (opts.body as FormData) : JSON.stringify(opts.body);

    let res: Response;
    try {
      res = await doFetch(`${base}${path}${buildQuery(opts.query)}`, init);
    } catch (err) {
      if (timedOut) throw new ApiError('timeout', 'The request took too long', 0);
      // Caller-initiated cancellation is not an error condition: surface the native AbortError untouched.
      if (opts.signal?.aborted) throw err;
      throw new ApiError('network_error', 'Could not reach the server', 0, null, {
        cause: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }

    const requestId = res.headers.get('x-request-id');
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: unknown;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }

    if (!res.ok) {
      const env = (
        json as
          | { error?: { code?: string; message?: string; details?: unknown; requestId?: string } }
          | undefined
      )?.error;
      const retryAfter = Number(res.headers.get('retry-after'));
      const err = new ApiError(
        env?.code ?? (json === undefined ? 'bad_response' : 'internal'),
        env?.message ?? `Request failed with status ${res.status}`,
        res.status,
        env?.requestId ?? requestId,
        env?.details,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      );
      if (res.status === 401 && !opts.skipUnauthorizedHook) options.onUnauthorized?.(err);
      throw err;
    }
    if (json === undefined && text)
      throw new ApiError(
        'bad_response',
        'The server returned an unreadable response',
        res.status,
        requestId,
      );
    return json as T;
  }

  return { request, mode };
}
