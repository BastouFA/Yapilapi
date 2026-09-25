import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { Shell } from '@/components/Shell';
import { AdminProvider } from '@/lib/session';
import { getServerSession } from '@/lib/server-session';
import { ServerUnavailable, NotStaff } from '@/components/Gate';

/**
 * Staff gate. The session is verified on the server on every document load by asking the API (GET /v1/auth/me and
 * GET /v1/admin/me) with the browser's httpOnly cookie. Client-side navigations rely on the API client's 401 hook.
 * This only decides what to render: the API authorises every request again (role, MFA, permission).
 */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession();
  const path = (await headers()).get('x-yl-path') ?? '/';
  const next = encodeURIComponent(path);
  if (session.status === 'anonymous') redirect(`/login?next=${next}`);
  if (session.status === 'mfa_required') redirect(`/login?reason=mfa&next=${next}`);
  if (session.status === 'unavailable') return <ServerUnavailable requestId={session.requestId} />;
  if (session.status === 'forbidden') return <NotStaff />;
  return (
    <AdminProvider user={session.user} admin={session.admin}>
      <Shell>{children}</Shell>
    </AdminProvider>
  );
}
