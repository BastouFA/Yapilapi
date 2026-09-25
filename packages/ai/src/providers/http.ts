import { ProviderError } from '../types.js';

export interface FetchResponseLike {
  status: number;
  ok: boolean;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

export const defaultFetch: FetchLike = (url, init) =>
  fetch(url, init) as unknown as Promise<FetchResponseLike>;

/** Map an HTTP status from a model API to a ProviderError kind (shared by the live adapters; unit-tested). */
export function errorKindForStatus(status: number): ProviderError['kind'] {
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status === 529 || status >= 500) return 'unavailable';
  return 'invalid_request';
}

export interface PostOptions {
  provider: string;
  fetchFn: FetchLike;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

/** POST JSON, returning the parsed body or throwing a ProviderError. Never logs or echoes credentials. */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  o: PostOptions,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(o.timeoutMs);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  let res: FetchResponseLike;
  try {
    res = await o.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'TimeoutError' || name === 'AbortError')
      throw new ProviderError('timeout', `${o.provider} request timed out`, o.provider);
    throw new ProviderError(
      'network',
      `${o.provider} request failed: ${(err as Error).message}`,
      o.provider,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = '';
    try {
      detail = String(
        (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? '',
      ).slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new ProviderError(
      errorKindForStatus(res.status),
      `${o.provider} returned ${res.status}${detail ? `: ${detail}` : ''}`,
      o.provider,
      res.status,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(
      'malformed_response',
      `${o.provider} returned a non-JSON body`,
      o.provider,
      res.status,
    );
  }
}

export function safeJsonObject(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
