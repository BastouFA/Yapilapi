import { connection } from 'next/server';

/**
 * The version of the site being served now (the commit it was built from). An open page compares
 * it with its own when it comes back to the screen and reloads when a newer one is out
 * (components/UpdateWhenBack.tsx), so home-screen apps that stay open for days still update.
 */
export async function GET() {
  await connection();
  return Response.json({ build: process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev' }, { headers: { 'cache-control': 'no-store' } });
}
