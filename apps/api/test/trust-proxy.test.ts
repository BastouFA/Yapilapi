import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { readConfig, trustProxySetting } from '../src/config.ts';

/** A server with the API's proxy setting that answers with the address it thinks the caller has. */
function whoAmI(env: Record<string, string> = {}) {
  const config = readConfig({ DATABASE_URL: 'postgres://unused', ...env });
  const app = Fastify({ trustProxy: config.TRUST_PROXY });
  app.get('/ip', async (req) => ({ ip: req.ip }));
  return app;
}

async function ipFor(app: ReturnType<typeof whoAmI>, from: string, forwardedFor?: string) {
  const res = await app.inject({ url: '/ip', remoteAddress: from, headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {} });
  return res.json().ip as string;
}

describe('who the caller is behind proxies', () => {
  it('ignores an address a caller writes into X-Forwarded-For themselves', async () => {
    const app = whoAmI();
    expect(await ipFor(app, '203.0.113.5', '6.6.6.6')).toBe('203.0.113.5');
  });

  it('believes the proxies on private networks, and only as far as they go', async () => {
    const app = whoAmI();
    // The phone through the host's load balancer.
    expect(await ipFor(app, '10.0.3.7', '198.51.100.20')).toBe('198.51.100.20');
    // The web app on the private network, after the load balancer, with a made-up entry in front.
    expect(await ipFor(app, '10.0.4.2', '6.6.6.6, 198.51.100.20, 10.0.3.7')).toBe('198.51.100.20');
    expect(await ipFor(app, '::1', '198.51.100.21')).toBe('198.51.100.21');
  });

  it('can be set to a number of hops or a list for other hosts', async () => {
    const oneHop = whoAmI({ TRUST_PROXY: '1' });
    expect(await ipFor(oneHop, '203.0.113.9', '6.6.6.6, 198.51.100.30')).toBe('198.51.100.30');
    expect(trustProxySetting('true')).toBe(true);
    expect(trustProxySetting('false')).toBe(false);
    expect(trustProxySetting(' 173.245.48.0/20, loopback ')).toEqual(['173.245.48.0/20', 'loopback']);
  });
});
