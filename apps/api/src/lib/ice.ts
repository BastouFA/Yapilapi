import { createHmac } from 'node:crypto';
import type { Config } from '../config.ts';

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type IceConfig = Pick<Config, 'TURN_URLS' | 'TURN_SECRET' | 'CLOUDFLARE_TURN_KEY_ID' | 'CLOUDFLARE_TURN_KEY_TOKEN'>;

function turnUrls(config: Pick<Config, 'TURN_URLS'>): string[] {
  return config.TURN_URLS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const cloudflare = (config: IceConfig) => !!config.CLOUDFLARE_TURN_KEY_ID && !!config.CLOUDFLARE_TURN_KEY_TOKEN;

/** Whether a TURN relay is set up (Cloudflare or coturn), so audio and video can be relayed instead of going peer to peer. */
export function turnConfigured(config: IceConfig): boolean {
  return cloudflare(config) || (turnUrls(config).length > 0 && !!config.TURN_SECRET);
}

// Cloudflare credentials last two days and are shared by everyone; asked for again once less
// than a day is left, so every call has at least a day.
const CF_TTL = 48 * 3600;
let cf: { servers: IceServer[]; until: number } | null = null;
let cfAsking: Promise<void> | null = null;

async function cloudflareServers(config: IceConfig): Promise<IceServer[]> {
  if (cf && cf.until - Date.now() > 24 * 3600_000) return cf.servers;
  cfAsking ??= fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(config.CLOUDFLARE_TURN_KEY_ID)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.CLOUDFLARE_TURN_KEY_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ttl: CF_TTL }),
    signal: AbortSignal.timeout(5000),
  })
    .then(async (r) => {
      if (!r.ok) throw new Error(`Cloudflare TURN: ${r.status}`);
      const { iceServers } = (await r.json()) as { iceServers: IceServer[] };
      // Port 53 times out in browsers.
      const servers = iceServers
        .map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => !/:53(\?|$)/.test(u)) }))
        .filter((s) => s.urls.length);
      cf = { servers, until: Date.now() + CF_TTL * 1000 };
    })
    .catch(() => {
      /* STUN only until the next try; most calls still connect */
    })
    .finally(() => (cfAsking = null));
  await cfAsking;
  return cf && cf.until > Date.now() ? cf.servers : [];
}

/**
 * STUN plus TURN credentials, used by calls and by audio rooms. Cloudflare when it's set up
 * (time-limited credentials from its API, cached); otherwise coturn's TURN REST API (username =
 * expiry:userId, credential = base64(HMAC-SHA1(secret, username))), valid for 12 hours.
 */
export async function iceServers(config: IceConfig, userId?: string): Promise<IceServer[]> {
  const servers: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (cloudflare(config)) return [...servers, ...(await cloudflareServers(config))];
  const urls = turnUrls(config);
  if (urls.length && config.TURN_SECRET && userId) {
    const username = `${Math.floor(Date.now() / 1000) + 12 * 3600}:${userId}`;
    const credential = createHmac('sha1', config.TURN_SECRET).update(username).digest('base64');
    servers.push({ urls, username, credential });
  }
  return servers;
}
