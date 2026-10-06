import { connection } from 'next/server';
import { appleAppSiteAssociation, isAppleTeamId } from '@yapilapi/shared';

/**
 * Tells iPhones which links on this site open the YAPILAPI app (universal links), and that the app
 * may use passwords saved for the site. Apple fetches it when the app is installed, so it must be
 * served here as JSON with no redirect.
 *
 * APPLE_TEAM_ID (Apple Developer > Membership details) is read at request time, so it can be set
 * on the running web service. Until it is, this answers 404 and links open in the browser.
 * docs/operations/real-device-testing.md, "Links that open the app".
 */
export async function GET() {
  await connection();
  const teamId = process.env.APPLE_TEAM_ID?.trim() ?? '';
  if (!isAppleTeamId(teamId)) return new Response('Not set up yet', { status: 404 });
  return Response.json(appleAppSiteAssociation(teamId), { headers: { 'cache-control': 'public, max-age=3600' } });
}
