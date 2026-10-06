import { connection } from 'next/server';
import { assetLinks, parseCertFingerprints } from '@yapilapi/shared';

/**
 * Tells Android phones that the YAPILAPI app, signed with these certificates, opens this site's
 * links (App Links) and may use passwords saved for it. Android checks it when the app is installed.
 *
 * ANDROID_CERT_SHA256 holds the SHA-256 fingerprints, separated by commas: the Play app signing key
 * (Play Console > App integrity) for store installs, and the EAS upload key (`eas credentials`) for
 * preview builds. Read at request time; until one is set, this answers 404 and links open in the
 * browser. docs/operations/real-device-testing.md, "Links that open the app".
 */
export async function GET() {
  await connection();
  const fingerprints = parseCertFingerprints(process.env.ANDROID_CERT_SHA256);
  if (!fingerprints.length) return new Response('Not set up yet', { status: 404 });
  return Response.json(assetLinks(fingerprints), { headers: { 'cache-control': 'public, max-age=3600' } });
}
