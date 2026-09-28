import { describe, expect, it } from 'vitest';
import { BlockedUrlError, isPrivateIp, safeFetch } from '../src/lib/safe-fetch.ts';
import { fakeWeb } from './fake-web.ts';

const PUBLIC = '93.184.216.34';

describe('outside fetches: which addresses count as private', () => {
  it('refuses loopback, private, link-local, CGNAT, benchmarking, reserved, multicast and unspecified addresses, in IPv4 and IPv6', () => {
    for (const ip of [
      '127.0.0.1',
      '127.8.9.10',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '100.127.255.255',
      '0.0.0.0',
      '198.18.0.1',
      '198.19.255.255',
      '192.0.0.8',
      '192.0.2.1',
      '203.0.113.9',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      '0:0:0:0:0:0:0:1',
      '[::1]',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      '::ffff:10.0.0.1',
      '::127.0.0.1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1%en0',
      'ff02::1',
      '64:ff9b::a00:1',
      '2001:db8::1',
      '2001::1',
      '2002:7f00:1::1',
      'not an address',
      '1.2.3',
    ])
      expect(isPrivateIp(ip), ip).toBe(true);
  });

  it('lets public addresses through', () => {
    for (const ip of [PUBLIC, '8.8.8.8', '192.0.78.9', '100.128.0.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:93.184.216.34', '2002:5db8:d822::1'])
      expect(isPrivateIp(ip), ip).toBe(false);
  });
});

describe('outside fetches: the connection goes only to the address that was checked', () => {
  it('fetches from a public host, looking it up once, with the name kept for TLS and the Host header', async () => {
    const web = await fakeWeb({ 'good.example/icon.png': () => ({ body: 'hello' }) }, () => [PUBLIC]);
    try {
      const res = await safeFetch('https://good.example/icon.png', {}, web.deps);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('hello');
      expect(web.lookups).toEqual(['good.example']);
      expect(web.connections).toEqual([{ host: 'good.example', addresses: [PUBLIC], servername: 'good.example' }]);
      expect(web.requests[0]).toMatchObject({ method: 'GET', host: 'good.example', path: '/icon.png' });
    } finally {
      await web.close();
    }
  });

  it('refuses a host whose DNS answers public for one lookup and private for the next (DNS rebinding)', async () => {
    const answers = [[PUBLIC], ['127.0.0.1'], [PUBLIC], ['169.254.169.254']];
    const web = await fakeWeb({ 'rebind.example/': () => ({ body: 'inside' }) }, () => answers.shift()!);
    try {
      // The first connection is checked and goes to the public address.
      expect((await safeFetch('https://rebind.example/', {}, web.deps)).status).toBe(200);
      // The next lookup says loopback: that connection is refused, whatever an earlier check said.
      await expect(safeFetch('https://rebind.example/', {}, web.deps)).rejects.toBeInstanceOf(BlockedUrlError);
      expect((await safeFetch('https://rebind.example/', {}, web.deps)).status).toBe(200);
      await expect(safeFetch('https://rebind.example/', {}, web.deps)).rejects.toThrow(/public internet/);
      // One lookup per connection and no other: nothing is looked up twice.
      expect(web.lookups).toHaveLength(4);
      expect(web.hits).toEqual(['GET rebind.example/', 'GET rebind.example/']);
      expect(web.connections.flatMap((c) => c.addresses)).toEqual([PUBLIC, PUBLIC]);
    } finally {
      await web.close();
    }
  });

  it('runs the check inside Node’s own connection too (no test connection in between)', async () => {
    const looked: string[] = [];
    const resolve = async (host: string) => (looked.push(host), ['127.0.0.1']);
    await expect(safeFetch('https://plain.example/', {}, { resolve })).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(safeFetch('https://plain.example/', { method: 'POST', body: '{}' }, { resolve })).rejects.toThrow(/public internet/);
    expect(looked).toEqual(['plain.example', 'plain.example']);
  });

  it('refuses a host when any one of its addresses is private', async () => {
    const web = await fakeWeb({}, () => [PUBLIC, '10.0.0.5']);
    try {
      await expect(safeFetch('https://mixed.example/', {}, web.deps)).rejects.toBeInstanceOf(BlockedUrlError);
      expect(web.connections).toEqual([]);
      expect(web.hits).toEqual([]);
    } finally {
      await web.close();
    }
  });

  it('refuses IPv6 loopback and IPv4 written as IPv6, from DNS and written in the URL', async () => {
    let answer: string[] = [];
    const web = await fakeWeb({}, () => answer);
    try {
      for (const a of ['::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fd00::1', 'fe80::1']) {
        answer = [a];
        await expect(safeFetch('https://v6.example/', {}, web.deps), a).rejects.toBeInstanceOf(BlockedUrlError);
      }
      for (const url of [
        'https://[::1]/',
        'https://[::ffff:127.0.0.1]/',
        'https://[::ffff:a9fe:a9fe]/',
        'https://127.0.0.1/',
        'https://2130706433/',
        'https://0x7f.1/',
      ])
        await expect(safeFetch(url, {}, web.deps), url).rejects.toBeInstanceOf(BlockedUrlError);
      expect(web.connections).toEqual([]);
      expect(web.hits).toEqual([]);
    } finally {
      await web.close();
    }
  });

  it('checks every redirect: one to a private address is refused, one to another public host is followed', async () => {
    const dns = (host: string) => (host === 'inside.example' ? ['10.0.0.5'] : [PUBLIC]);
    const web = await fakeWeb(
      {
        'hop.example/a': () => ({ status: 302, headers: { location: 'https://inside.example/secret' } }),
        'hop.example/b': () => ({ status: 301, headers: { location: 'http://127.0.0.1/secret' } }),
        'hop.example/c': () => ({ status: 302, headers: { location: 'http://other.example/x' } }),
        'hop.example/d': () => ({ status: 307, headers: { location: 'https://other.example/x' } }),
        'hop.example/loop': () => ({ status: 302, headers: { location: '/loop' } }),
        'other.example/x': () => ({ body: 'arrived' }),
      },
      dns,
    );
    try {
      await expect(safeFetch('https://hop.example/a', { maxRedirects: 2 }, web.deps)).rejects.toBeInstanceOf(BlockedUrlError);
      await expect(safeFetch('https://hop.example/b', { maxRedirects: 2 }, web.deps)).rejects.toBeInstanceOf(BlockedUrlError);
      // Plain http is refused on a redirect too.
      await expect(safeFetch('https://hop.example/c', { maxRedirects: 2 }, web.deps)).rejects.toThrow(/https/);
      expect(web.hits).toEqual(['GET hop.example/a', 'GET hop.example/b', 'GET hop.example/c']);

      const ok = await safeFetch('https://hop.example/d', { maxRedirects: 2 }, web.deps);
      expect(await ok.text()).toBe('arrived');
      expect(web.connections.at(-1)).toEqual({ host: 'other.example', addresses: [PUBLIC], servername: 'other.example' });
      // Past the limit the redirect itself comes back; with no limit, redirects aren't followed at all.
      expect((await safeFetch('https://hop.example/loop', { maxRedirects: 2 }, web.deps)).status).toBe(302);
      expect(web.hits.filter((h) => h.endsWith('/loop'))).toHaveLength(3);
      expect((await safeFetch('https://hop.example/d', {}, web.deps)).status).toBe(307);
    } finally {
      await web.close();
    }
  });

  it('sends a POST body with its headers, and refuses http, credentials and bad URLs before connecting', async () => {
    const web = await fakeWeb({ 'hooks.example/in': (_req, body) => ({ status: 201, body: `got ${body}` }) }, () => [PUBLIC]);
    try {
      const res = await safeFetch('https://hooks.example/in', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' }, web.deps);
      expect(res.status).toBe(201);
      expect(await res.text()).toBe('got {"a":1}');
      expect(web.requests[0]!.headers['content-type']).toBe('application/json');

      for (const url of ['http://hooks.example/in', 'https://user:pass@hooks.example/in', 'ftp://hooks.example/', 'not a url'])
        await expect(safeFetch(url, {}, web.deps), url).rejects.toBeInstanceOf(BlockedUrlError);
      expect(web.hits).toHaveLength(1);
    } finally {
      await web.close();
    }
  });
});
