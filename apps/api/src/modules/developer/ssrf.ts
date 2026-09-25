import { isIP } from 'node:net';
import dns from 'node:dns';
import https from 'node:https';
import { AppError } from '@yapilapi/shared';

/**
 * Outbound-request safety for developer webhooks (SSRF protection).
 *
 * Layers, all of which must hold:
 *   1. `validateWebhookUrl`: https only, no credentials, standard ports, no IP-literal hosts in blocked ranges, no
 *      internal-looking hostnames. Runs when an endpoint is registered AND before every delivery.
 *   2. `resolvePublicAddress`: DNS is resolved by us and EVERY returned address must be public. A hostname with one
 *      private A/AAAA record is rejected outright (defeats "public + private" answer tricks).
 *   3. `httpsTransport` connects to the address we validated (pinned lookup, original hostname kept for SNI/certificate
 *      verification), so DNS cannot change between "check" and "connect" (rebinding).
 *   4. Redirects are never followed (a 3xx is a failed delivery), the response body is capped and the whole request has
 *      a hard timeout.
 */

// ------------------------------------------------------------------ IP classification (pure)

function parseIPv4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

/** Expand an IPv6 literal to eight 16-bit groups. Returns null when it is not valid IPv6. */
export function parseIPv6(input: string): number[] | null {
  let ip = input.trim().toLowerCase();
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  if (isIP(ip) !== 6) return null;

  // Embedded dotted quad in the last 32 bits (::ffff:1.2.3.4).
  const lastColon = ip.lastIndexOf(':');
  const tail = ip.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    ip = `${ip.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves[1] !== undefined && halves[1] !== '' ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups =
    halves.length === 1 ? head : [...head, ...Array<string>(missing).fill('0'), ...rest];
  const nums = groups.map((g) => parseInt(g || '0', 16));
  return nums.length === 8 && nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)
    ? nums
    : null;
}

function blockedV4(p: number[]): boolean {
  const [a, b, c] = p as [number, number, number, number];
  return (
    a === 0 || // "this" network
    a === 10 || // private
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local incl. cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol assignments / TEST-NET-1
    (a === 192 && b === 88 && c === 99) || // 6to4 relay (deprecated)
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/** True when the address must never be contacted by the server (private, loopback, link-local, reserved, metadata...). */
export function isBlockedIp(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return blockedV4(v4);
  const g = parseIPv6(ip);
  if (!g) return true; // unparseable: fail closed
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const embedded = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.every((x) => x === 0)) return true; // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1)
    return true; // ::1
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff)
    return blockedV4(embedded(g6, g7)); // ::ffff:a.b.c.d
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0)
    return blockedV4(embedded(g6, g7)); // ::a.b.c.d (deprecated compat)
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0)
    return blockedV4(embedded(g6, g7)); // NAT64
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true; // local-use NAT64
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x2001 && g1 === 0) return true; // teredo
  if (g0 === 0x2002) return blockedV4(embedded(g1, g2)); // 6to4 embeds an IPv4 address
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // discard-only
  return false;
}

// ------------------------------------------------------------------ URL validation (pure)

const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.localdomain',
  '.lan',
  '.home',
  '.corp',
  '.intranet',
  '.arpa',
];
const ALLOWED_PORTS = new Set(['', '443', '8443']);

export class WebhookUrlError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/** Throws WebhookUrlError describing why `raw` cannot be used as a webhook destination; returns the parsed URL otherwise. */
export function validateWebhookUrl(raw: string): URL {
  if (raw.length > 2048) throw new WebhookUrlError('too_long', 'URL is too long');
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new WebhookUrlError('malformed', 'URL is not valid');
  }
  if (u.protocol !== 'https:') throw new WebhookUrlError('scheme', 'Webhook URLs must use https');
  if (u.username || u.password)
    throw new WebhookUrlError('credentials', 'Webhook URLs must not contain credentials');
  if (!ALLOWED_PORTS.has(u.port))
    throw new WebhookUrlError('port', 'Webhook URLs must use port 443 or 8443');
  if (u.hash) throw new WebhookUrlError('fragment', 'Webhook URLs must not contain a fragment');

  // WHATWG URL already normalises 0x7f.1, 2130706433, 017700000001 etc. into dotted quads.
  const host = u.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (!host) throw new WebhookUrlError('host', 'URL has no host');
  if (isIP(host)) {
    if (isBlockedIp(host))
      throw new WebhookUrlError('blocked_address', 'That address is not allowed');
    return u;
  }
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)))
    throw new WebhookUrlError('blocked_host', 'That host is not allowed');
  if (!host.includes('.'))
    throw new WebhookUrlError('blocked_host', 'Use a fully-qualified domain name');
  return u;
}

// ------------------------------------------------------------------ DNS + transport

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type LookupAll = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemLookup: LookupAll = async (hostname) => {
  const res = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return res.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

/** Resolve `hostname` and return one address, requiring that ALL answers are public. */
export async function resolvePublicAddress(
  hostname: string,
  lookup: LookupAll = systemLookup,
): Promise<ResolvedAddress> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isBlockedIp(host))
      throw new WebhookUrlError('blocked_address', 'That address is not allowed');
    return { address: host, family: isIP(host) === 6 ? 6 : 4 };
  }
  let answers: ResolvedAddress[];
  try {
    answers = await lookup(host);
  } catch {
    throw new WebhookUrlError('dns_failure', 'The host name could not be resolved');
  }
  if (answers.length === 0)
    throw new WebhookUrlError('dns_failure', 'The host name did not resolve');
  if (answers.some((a) => isBlockedIp(a.address)))
    throw new WebhookUrlError(
      'blocked_address',
      'The host resolves to a private or reserved address',
    );
  return answers[0]!;
}

export interface OutboundRequest {
  url: URL;
  address: ResolvedAddress;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}
export interface OutboundResponse {
  status: number;
}
export type WebhookTransport = (req: OutboundRequest) => Promise<OutboundResponse>;

export interface WebhookNetwork {
  lookup: LookupAll;
  transport: WebhookTransport;
}

const MAX_RESPONSE_BYTES = 64 * 1024;

/** Production transport: TLS to the pinned, already-validated address; never follows redirects. */
export const httpsTransport: WebhookTransport = (req) =>
  new Promise<OutboundResponse>((resolve, reject) => {
    const r = https.request(
      {
        protocol: 'https:',
        hostname: req.url.hostname.replace(/^\[|\]$/g, ''),
        port: req.url.port || 443,
        path: `${req.url.pathname}${req.url.search}`,
        method: 'POST',
        headers: { ...req.headers, 'content-length': String(Buffer.byteLength(req.body)) },
        servername: isIP(req.url.hostname.replace(/^\[|\]$/g, '')) ? undefined : req.url.hostname,
        // Pin the connection to the validated address: whatever DNS says now is ignored.
        lookup: ((
          _h: string,
          _o: unknown,
          cb: (err: Error | null, address: string, family: number) => void,
        ) => cb(null, req.address.address, req.address.family)) as never,
        timeout: req.timeoutMs,
        rejectUnauthorized: true,
      },
      (res) => {
        let seen = 0;
        res.on('data', (chunk: Buffer) => {
          seen += chunk.length;
          if (seen > MAX_RESPONSE_BYTES) res.destroy();
        });
        res.on('error', () => undefined);
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        res.on('close', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    r.end(req.body);
  });

export const defaultNetwork: WebhookNetwork = { lookup: systemLookup, transport: httpsTransport };

let network: WebhookNetwork = defaultNetwork;
/** Test seam: swap DNS/transport. Pass nothing to restore the real network. */
export function setWebhookNetwork(n?: Partial<WebhookNetwork>): void {
  network = { ...defaultNetwork, ...n };
}
export const getWebhookNetwork = (): WebhookNetwork => network;

/** Full destination check used at registration time: syntax rules plus DNS. Throws a 400 AppError. */
export async function assertWebhookDestination(raw: string): Promise<URL> {
  try {
    const u = validateWebhookUrl(raw);
    await resolvePublicAddress(u.hostname, network.lookup);
    return u;
  } catch (e) {
    if (e instanceof WebhookUrlError)
      throw new AppError('validation_failed', e.message, { field: 'url', reason: e.reason });
    throw e;
  }
}
