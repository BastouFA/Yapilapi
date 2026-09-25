import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { SessionProvider } from '@/lib/session';
import { getServerSession } from '@/lib/server-session';
import { ServerUnavailable } from '@/components/ServerUnavailable';

/**
 * Auth guard. The session is verified on the server on every document load and refresh of this group by asking the API
 * (GET /v1/auth/me) with the browser's httpOnly cookie. Only a real 401 redirects to sign-in.
 * Client-side navigations rely on the API client's onUnauthorized hook, which redirects to sign-in on any 401.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  const path = (await headers()).get('x-yl-path') ?? '/';
  if (session.status === 'anonymous') redirect(`/login?next=${encodeURIComponent(path)}`);
  if (session.status === 'unavailable') return <ServerUnavailable requestId={session.requestId} />;
  // Accounts that have not finished onboarding resume the sign-up flow (interests, people).
  if (!session.me.user.profile.onboardingCompleted) redirect('/signup');
  return (
    <SessionProvider initial={session.me}>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  );
}
