import { redirect } from 'next/navigation';
import { LoginFlow } from '@/components/LoginFlow';
import { safeNext } from '@/lib/redirect';
import { getServerSession } from '@/lib/server-session';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; reason?: string }>;
}) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  // An MFA-verified staff session has no business on the sign-in page.
  if ((await getServerSession()).status === 'ok') redirect(next);
  return <LoginFlow next={next} reason={sp.reason} />;
}
