import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable, type Duplex } from 'node:stream';

/**
 * Fetching addresses people give us (webhooks, link icons) without letting them reach our own
 * network. Every outside fetch goes through `safeFetch`:
 *
 * - https only (plain http only to localhost, and only where the caller allows it for development);
 * - no credentials in the URL;
 * - a host written as an address must be public;
 * - a host name is looked up once per connection, inside the connection itself: if any address it
 *   gives is not public the connection is refused, and otherwise the connection goes to exactly
 *   the addresses that were checked. There is no second lookup a hostile DNS server could answer
 *   differently (DNS rebinding). TLS still checks the certificate against the name, and the Host
 *   header carries it;
 * - redirects are followed by hand, up to the caller's limit, and every hop is checked the same way;
 * - no connection is reused between requests.
 */

/** Looks up every address of a host. */
export type Resolve = (host: string) => Promise<string[]>;

export const systemResolve: Resolve = async (host) => (await lookup(host, { all: true, order: 'verbatim' })).map((a) => a.address);

/** Raised when an address or URL may not be fetched. Its message is safe to show to the person who gave the URL. */
export class BlockedUrlError extends Error {
  readonly code = 'ERR_BLOCKED_URL';
}

function parseIpv4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return null;
  const bytes = parts.map(Number);
  return bytes.every((b) => b <= 255) ? bytes : null;
}

/** The 16 bytes of an IPv6 address (zone ids dropped, a trailing dotted IPv4 part allowed), or null. */
function parseIpv6(s: string): number[] | null {
  let str = s.replace(/%.*$/, '').toLowerCase();
  const lastColon = str.lastIndexOf(':');
  if (str.includes('.', lastColon)) {
    const v4 = parseIpv4(str.slice(lastColon + 1));
    if (!v4) return null;
    str = `${str.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const groups = (h: string | undefined) => (h ? h.split(':') : []);
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  if (![...head, ...tail].every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const words = [...head, ...Array<string>(missing).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return words.flatMap((w) => [w >> 8, w & 0xff]);
}

function privateIpv4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this network"
    a === 10 ||
    (a === 100 && b! >= 64 && b! <= 127) || // shared address space (CGNAT)
    a === 127 ||
    (a === 169 && b === 254) || // link-local, including cloud metadata
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // protocol assignments, documentation
    (a === 192 && b === 88 && c === 99) || // 6to4 relays
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // documentation
    (a === 203 && b === 0 && c === 113) || // documentation
    a! >= 224 // multicast, reserved and broadcast
  );
}

function privateIpv6(x: number[]): boolean {
  const word = (i: number) => (x[2 * i]! << 8) | x[2 * i + 1]!;
  // ::/96 (unspecified, loopback, IPv4-compatible) and ::ffff:0:0/96 (IPv4-mapped): the IPv4 part decides for mapped ones.
  if ([0, 1, 2, 3, 4].every((i) => word(i) === 0)) return word(5) === 0xffff ? privateIpv4(x.slice(12)) : true;
  // Only global unicast (2000::/3) is public: this refuses unique local fc00::/7, link-local fe80::/10,
  // multicast ff00::/8, NAT64 64:ff9b::/96, discard 100::/64 and everything unassigned.
  if ((word(0) & 0xe000) !== 0x2000) return true;
  if (word(0) === 0x2001 && word(1) < 0x0200) return true; // Teredo, benchmarking, ORCHID and other special use
  if (word(0) === 0x2001 && word(1) === 0x0db8) return true; // documentation
  if (word(0) === 0x3fff && word(1) < 0x1000) return true; // documentation
  if (word(0) === 0x2002) return privateIpv4(x.slice(2, 6)); // 6to4 carries an IPv4 address
  return false;
}

/**
 * Addresses that aren't on the public internet: loopback, private, link-local, shared (CGNAT),
 * benchmarking, documentation, reserved, multicast and unspecified, in IPv4 and IPv6, including
 * IPv4 written as IPv6. Anything that doesn't parse counts as private.
 */
export function isPrivateIp(ip: string): boolean {
  const s = ip.replace(/^\[|\]$/g, '');
  if (s.includes(':')) {
    const bytes = parseIpv6(s);
    return !bytes || privateIpv6(bytes);
  }
  const bytes = parseIpv4(s);
  return !bytes || privateIpv4(bytes);
}

/**
 * A lookup for `net.connect` that resolves the host once, refuses the connection if any address is
 * not public, and hands back exactly the addresses it checked. It runs for every connection, so
 * each redirect hop and each retry is checked again.
 */
export function publicLookup(resolve: Resolve = systemResolve): LookupFunction {
  return (hostname, options, callback) => {
    const checked = (async () => {
      const addrs = await resolve(hostname);
      if (!addrs.length) throw new BlockedUrlError("That host doesn't resolve.");
      if (addrs.some(isPrivateIp)) throw new BlockedUrlError('That host points to an address that isn’t on the public internet.');
      const all = addrs.map((address) => ({ address, family: isIP(address) }));
      const wanted = options.family === 4 || options.family === 6 ? all.filter((a) => a.family === options.family) : all;
      if (!wanted.length) throw new BlockedUrlError("That host doesn't resolve.");
      return wanted;
    })();
    checked.then(
      (list) => (options.all ? callback(null, list) : callback(null, list[0]!.address, list[0]!.family)),
      (err: NodeJS.ErrnoException) => callback(err, ''),
    );
  };
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * The shape rules for a URL we may fetch: https, no credentials, and a public address when the host
 * is written as one. `allowLocal` (development and tests only) lets through http and https to
 * localhost. `label` names the URL in messages ("Webhook URLs must use https.").
 */
export function checkOutboundUrl(raw: string, opts: { allowLocal?: boolean; label?: string } = {}): { url: URL; local: boolean } {
  const label = opts.label ?? 'Links';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError('Enter a full URL, like https://example.com.');
  }
  const local = LOCAL_HOSTS.includes(url.hostname) && (url.protocol === 'http:' || url.protocol === 'https:');
  if (opts.allowLocal && local) return { url, local: true };
  if (url.protocol !== 'https:') throw new BlockedUrlError(`${label} must use https.`);
  if (url.username || url.password) throw new BlockedUrlError(`${label} cannot contain credentials.`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateIp(host)) throw new BlockedUrlError(`${label} must point to a public address.`);
  return { url, local: false };
}

export interface SafeFetchInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Redirects to follow (each one checked like the first URL). After that a redirect is returned as it is. Default 0. */
  maxRedirects?: number;
  /** Development and tests only: allow http and https to localhost. */
  allowLocal?: boolean;
  /** Names the URL in error messages. */
  label?: string;
}

export interface SafeFetchDeps {
  /** Looks up a host's addresses (tests pass a fake DNS). */
  resolve?: Resolve;
  /**
   * Tests only: opens the connection in place of net/tls, given the options Node would connect with
   * (host, port, servername and the checking `lookup`), so a test can see what was checked and send
   * the bytes to a local server instead of the internet.
   */
  connect?: (options: http.ClientRequestArgs) => Duplex;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

interface Hop {
  url: URL;
  local: boolean;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function requestOnce({ url, local, method, headers: given, body }: Hop, signal: AbortSignal | undefined, deps: SafeFetchDeps): Promise<Response> {
  const secure = url.protocol === 'https:';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const defaultPort = secure ? 443 : 80;
  const headers: Record<string, string> = { 'accept-encoding': 'identity', ...given };
  if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
  const options: https.RequestOptions = {
    protocol: url.protocol,
    hostname: host,
    port: url.port ? Number(url.port) : defaultPort,
    defaultPort,
    path: `${url.pathname}${url.search}`,
    method,
    headers,
    signal,
    // Local development hosts are looked up normally; everything else only through the check.
    ...(local || isIP(host) ? {} : { lookup: publicLookup(deps.resolve) }),
    ...(secure && !isIP(host) ? { servername: host } : {}),
    ...(deps.connect ? { createConnection: deps.connect } : { agent: false }),
  };
  return new Promise((resolvePromise, reject) => {
    const req = (secure ? https : http).request(options, (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status > 599) {
        res.destroy();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      const out = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) for (const one of v) out.append(k, one);
        else if (v !== undefined) out.set(k, v);
      }
      const empty = [204, 205, 304].includes(status);
      if (empty) res.resume();
      resolvePromise(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage, headers: out }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Fetch an outside URL under the rules above. Returns a standard Response; its body is read as a
 * stream, so callers keep their own size limits. Throws BlockedUrlError for a URL or address that
 * isn't allowed, and the usual network errors otherwise.
 */
export async function safeFetch(raw: string, init: SafeFetchInit = {}, deps: SafeFetchDeps = {}): Promise<Response> {
  const hop: Hop = { ...checkOutboundUrl(raw, init), method: init.method ?? 'GET', headers: { ...init.headers }, body: init.body };
  for (let n = 0; ; n++) {
    const res = await requestOnce(hop, init.signal, deps);
    const next = res.headers.get('location');
    if (!REDIRECTS.has(res.status) || !next || n >= (init.maxRedirects ?? 0)) return res;
    await res.body?.cancel().catch(() => {});
    Object.assign(hop, checkOutboundUrl(new URL(next, hop.url).toString(), init));
    // As browsers do: 303, and 301/302 after a POST, continue as a GET without the body.
    if (res.status === 303 || (hop.method === 'POST' && (res.status === 301 || res.status === 302))) {
      hop.method = 'GET';
      hop.body = undefined;
      delete hop.headers['content-type'];
    }
  }
}
