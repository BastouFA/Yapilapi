import { createHmac } from 'node:crypto';
import type { Config } from '../config.ts';

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

function turnUrls(config: Pick<Config, 'TURN_URLS'>): string[] {
  return config.TURN_URLS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Whether TURN (coturn) is set up, so audio can be relayed instead of going peer to peer. */
export function turnConfigured(config: Pick<Config, 'TURN_URLS' | 'TURN_SECRET'>): boolean {
  return turnUrls(config).length > 0 && !!config.TURN_SECRET;
}

/**
 * STUN plus time-limited TURN credentials (TURN REST API: username = expiry:userId,
 * credential = base64(HMAC-SHA1(secret, username))), valid for 12 hours. Used by
 * calls and by audio rooms.
 */
export function iceServers(config: Pick<Config, 'TURN_URLS' | 'TURN_SECRET'>, userId?: string): IceServer[] {
  const servers: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
  const urls = turnUrls(config);
  if (urls.length && config.TURN_SECRET && userId) {
    const username = `${Math.floor(Date.now() / 1000) + 12 * 3600}:${userId}`;
    const credential = createHmac('sha1', config.TURN_SECRET).update(username).digest('base64');
    servers.push({ urls, username, credential });
  }
  return servers;
}
