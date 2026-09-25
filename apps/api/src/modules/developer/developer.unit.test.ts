import { describe, expect, it } from 'vitest';
import {
  isBlockedIp,
  parseIPv6,
  resolvePublicAddress,
  validateWebhookUrl,
  WebhookUrlError,
} from './ssrf.js';
import {
  parseScopes,
  pkceChallengeFromVerifier,
  validateRedirectUri,
  verifyPkce,
} from './oauth.js';
import { nextRetryDelaySec, MAX_ATTEMPTS } from './webhooks.js';

describe('isBlockedIp', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '169.254.0.1',
    '0.0.0.0',
    '0.1.2.3',
    '100.64.0.1',
    '100.127.255.255',
    '192.0.0.1',
    '192.0.2.5',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '239.255.255.255',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:10.1.2.3',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'fec0::1',
    'ff02::1',
    '2001:db8::1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::1',
    '2002:0a00:0001::',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
  ])('blocks %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '192.169.0.1',
    '198.20.0.1',
    '11.0.0.1',
    '2606:4700:4700::1111',
    '2a00:1450:4009:81f::200e',
    '64:ff9b::808:808',
    '2002:0808:0808::',
  ])('allows public %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it('fails closed on garbage', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
    expect(isBlockedIp('999.1.1.1')).toBe(true);
    expect(isBlockedIp('')).toBe(true);
  });

  it('parses IPv6 forms', () => {
    expect(parseIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIPv6('[2001:db8::2:1]')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 2, 1]);
    expect(parseIPv6('1.2.3.4')).toBeNull();
  });
});

describe('validateWebhookUrl', () => {
  const bad: Array<[string, string]> = [
    ['http://example.com/hook', 'scheme'],
    ['ftp://example.com/x', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['https://user:pw@example.com/x', 'credentials'],
    ['https://example.com:22/x', 'port'],
    ['https://example.com:8080/x', 'port'],
    ['https://example.com/x#frag', 'fragment'],
    ['https://localhost/x', 'blocked_host'],
    ['https://foo.localhost/x', 'blocked_host'],
    ['https://printer.local/x', 'blocked_host'],
    ['https://metadata.google.internal/x', 'blocked_host'],
    ['https://intranet/x', 'blocked_host'],
    ['https://127.0.0.1/x', 'blocked_address'],
    ['https://2130706433/x', 'blocked_address'], // decimal form of 127.0.0.1
    ['https://0x7f.1/x', 'blocked_address'], // hex form
    ['https://017700000001/x', 'blocked_address'], // octal form
    ['https://[::1]/x', 'blocked_address'],
    ['https://[::ffff:127.0.0.1]/x', 'blocked_address'],
    ['https://169.254.169.254/latest/meta-data/', 'blocked_address'],
    ['https://10.0.0.5/x', 'blocked_address'],
    ['https://192.168.0.10/x', 'blocked_address'],
    ['https://[fd00::1]/x', 'blocked_address'],
    ['https://example.com./../x' + 'a'.repeat(2100), 'too_long'],
    ['not a url', 'malformed'],
  ];
  it.each(bad)('rejects %s (%s)', (url, reason) => {
    try {
      validateWebhookUrl(url);
      expect.unreachable(`${url} should have been rejected`);
    } catch (e) {
      expect(e).toBeInstanceOf(WebhookUrlError);
      expect((e as WebhookUrlError).reason).toBe(reason);
    }
  });

  it('accepts ordinary public https endpoints', () => {
    expect(validateWebhookUrl('https://hooks.example.com/yapilapi?x=1').hostname).toBe(
      'hooks.example.com',
    );
    expect(validateWebhookUrl('https://hooks.example.com:8443/x').port).toBe('8443');
    expect(validateWebhookUrl('https://93.184.216.34/x').hostname).toBe('93.184.216.34');
  });
});

describe('resolvePublicAddress (DNS rebinding / mixed answers)', () => {
  it('returns a public address', async () => {
    const r = await resolvePublicAddress('hooks.example.com', async () => [
      { address: '93.184.216.34', family: 4 },
    ]);
    expect(r.address).toBe('93.184.216.34');
  });
  it('rejects when ANY answer is private, even if others are public', async () => {
    await expect(
      resolvePublicAddress('evil.example.com', async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]),
    ).rejects.toMatchObject({ reason: 'blocked_address' });
    await expect(
      resolvePublicAddress('evil.example.com', async () => [
        { address: '::ffff:169.254.169.254', family: 6 },
      ]),
    ).rejects.toMatchObject({ reason: 'blocked_address' });
  });
  it('treats resolution failures and empty answers as failures', async () => {
    await expect(
      resolvePublicAddress('nx.example.com', async () => {
        throw new Error('ENOTFOUND');
      }),
    ).rejects.toMatchObject({ reason: 'dns_failure' });
    await expect(resolvePublicAddress('nx.example.com', async () => [])).rejects.toMatchObject({
      reason: 'dns_failure',
    });
  });
  it('checks IP literals without DNS', async () => {
    await expect(
      resolvePublicAddress('[::1]', async () => {
        throw new Error('must not resolve');
      }),
    ).rejects.toMatchObject({ reason: 'blocked_address' });
  });
});

describe('PKCE', () => {
  // RFC 7636 appendix B test vector
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  it('matches the RFC 7636 vector', () => {
    expect(pkceChallengeFromVerifier(verifier)).toBe(challenge);
    expect(verifyPkce(verifier, challenge)).toBe(true);
  });
  it('rejects wrong, short or malformed verifiers and challenges', () => {
    expect(verifyPkce(`${verifier}x`, challenge)).toBe(false);
    expect(verifyPkce('short', pkceChallengeFromVerifier('short'))).toBe(false); // below the 43 char minimum
    expect(verifyPkce(`${verifier}!`, challenge)).toBe(false);
    expect(verifyPkce(verifier, 'plain-not-hashed')).toBe(false);
    expect(verifyPkce(verifier, verifier)).toBe(false); // "plain" method is not supported
  });
});

describe('scopes and redirect URIs', () => {
  it('parses known scopes and rejects unknown ones', () => {
    expect(parseScopes('profile:read posts:read profile:read')).toEqual([
      'profile:read',
      'posts:read',
    ]);
    expect(parseScopes('profile:read admin')).toBeNull();
    expect(parseScopes('')).toBeNull();
    expect(parseScopes(undefined)).toBeNull();
  });
  it.each([
    ['https://app.example.com/cb', true],
    ['http://localhost:3000/cb', true],
    ['http://127.0.0.1:8080/cb', true],
    ['http://app.example.com/cb', false],
    ['https://app.example.com/cb#x', false],
    ['https://u:p@app.example.com/cb', false],
    ['https://*.example.com/cb', false],
    ['javascript:alert(1)', false],
    ['myapp://cb', false],
    ['nonsense', false],
  ])('redirect URI %s -> %s', (uri, ok) => {
    expect(validateRedirectUri(uri)).toBe(ok);
  });
});

describe('webhook retry schedule', () => {
  it('backs off and eventually gives up', () => {
    expect(nextRetryDelaySec(1)).toBe(60);
    expect(nextRetryDelaySec(2)).toBe(300);
    expect(nextRetryDelaySec(6)).toBe(43200);
    expect(nextRetryDelaySec(MAX_ATTEMPTS)).toBeNull();
    const delays = Array.from({ length: MAX_ATTEMPTS - 1 }, (_, i) => nextRetryDelaySec(i + 1)!);
    expect([...delays].sort((a, b) => a - b)).toEqual(delays);
  });
});
