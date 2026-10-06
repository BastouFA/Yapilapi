import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ANDROID_PACKAGE, APP_LINK_PATHS, appleAppSiteAssociation, assetLinks, IOS_BUNDLE_ID, isAppleTeamId, parseCertFingerprints } from './app-links.ts';

const FP = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');

describe('app links', () => {
  it('names the same app as the phone build', () => {
    const app = JSON.parse(readFileSync(new URL('../../../apps/mobile/app.json', import.meta.url), 'utf8')).expo;
    expect(IOS_BUNDLE_ID).toBe(app.ios.bundleIdentifier);
    expect(ANDROID_PACKAGE).toBe(app.android.package);
  });

  it('keeps sign-in, settings, the legal pages and the browser-only prefix out', () => {
    for (const p of APP_LINK_PATHS) expect(p.startsWith('/')).toBe(true);
    for (const kept of ['/login', '/signup', '/settings', '/legal', '/web', '/oauth', '/api', '/media', '/.well-known']) {
      expect(APP_LINK_PATHS.some((p) => kept.startsWith(p) || p.startsWith(kept))).toBe(false);
    }
  });

  it('builds the Apple file from the team id and the paths', () => {
    const f = appleAppSiteAssociation('ABCDE12345');
    expect(f.applinks.details[0]!.appIDs).toEqual(['ABCDE12345.com.yapilapi.app']);
    expect(f.webcredentials.apps).toEqual(['ABCDE12345.com.yapilapi.app']);
    const paths = f.applinks.details[0]!.components.map((c) => c['/']);
    expect(paths).toContain('/p/*');
    expect(paths).toContain('/reels');
    expect(paths).toContain('/reels/*');
    expect(paths).toContain('/@*');
    expect(paths.every((p) => !p.includes('//'))).toBe(true);
  });

  it('builds the Android file from the fingerprints', () => {
    const [entry] = assetLinks([FP]);
    expect(entry!.target).toEqual({ namespace: 'android_app', package_name: 'com.yapilapi.app', sha256_cert_fingerprints: [FP] });
    expect(entry!.relation).toContain('delegate_permission/common.handle_all_urls');
  });

  it('reads team ids and fingerprints from settings', () => {
    expect(isAppleTeamId('ABCDE12345')).toBe(true);
    expect(isAppleTeamId('<team id>')).toBe(false);
    expect(isAppleTeamId('abcde12345')).toBe(false);
    expect(parseCertFingerprints(`${FP.toLowerCase()}, ${FP} nonsense`)).toEqual([FP]);
    expect(parseCertFingerprints(undefined)).toEqual([]);
    expect(parseCertFingerprints('AB:CD')).toEqual([]);
  });
});
