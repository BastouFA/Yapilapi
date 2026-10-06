import links from './app-links.json';

/**
 * Web links that open the phone app when it is installed (iOS universal links, Android App Links).
 * One list, in app-links.json, read by three places: the phone build (apps/mobile/app.config.js,
 * associated domains and the Android intent filter), and the two files the web app serves for the
 * phone systems to check (apps/web/app/.well-known). Each entry is a path prefix the phone app has
 * a screen for (apps/mobile/lib/links.ts, appPath). Everything else on the site (sign-in, the legal
 * pages, settings, checkout) stays in the browser.
 *
 * Pages the phone app sends people to on purpose (checkout, Studio, buying a ticket to a live) open
 * at /web/<path>, which no app link covers; the web app redirects it to /<path>, so they stay in
 * the browser even when the path is on this list. docs/operations/real-device-testing.md.
 */
export const APP_LINK_PATHS: readonly string[] = links.paths;
export const IOS_BUNDLE_ID = links.iosBundleId;
export const ANDROID_PACKAGE = links.androidPackage;

/** An Apple team id: ten capital letters and digits (Apple Developer > Membership details). */
export const isAppleTeamId = (s: string) => /^[A-Z0-9]{10}$/.test(s);

/** A signing certificate's SHA-256 fingerprint as Google prints it: 32 pairs of hex digits joined by colons. */
export const isCertFingerprint = (s: string) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(s);

/** Fingerprints from a setting (commas or spaces between them), in Google's form; ones that aren't fingerprints are left out. */
export function parseCertFingerprints(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(/[\s,]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(isCertFingerprint),
    ),
  ];
}

/** An app-link path prefix as an Apple URL pattern: `/p/` matches `/p/*`, `/reels` matches `/reels` and below. */
function applePatterns(prefix: string): string[] {
  if (prefix.endsWith('/')) return [`${prefix}*`];
  if (prefix === '/@') return ['/@*'];
  return [prefix, `${prefix}/*`];
}

/**
 * The apple-app-site-association file: these paths open the iPhone app, and passwords saved for the
 * site can fill in its sign-in (webcredentials). `teamId` comes from the web service's settings.
 */
export function appleAppSiteAssociation(teamId: string) {
  const appId = `${teamId}.${IOS_BUNDLE_ID}`;
  return {
    applinks: {
      details: [{ appIDs: [appId], components: APP_LINK_PATHS.flatMap(applePatterns).map((path) => ({ '/': path })) }],
    },
    webcredentials: { apps: [appId] },
  };
}

/** The assetlinks.json file: the Android app signed with these certificates may open the site's links and use its saved passwords. */
export function assetLinks(fingerprints: readonly string[]) {
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
      target: { namespace: 'android_app', package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: [...fingerprints] },
    },
  ];
}
