import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/auth/LoginForm';
import { getServerSession } from '@/lib/server-session';
import { safeNext } from '@/lib/age';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const session = await getServerSession();
  if (session.status === 'ok') redirect(next);
  return <LoginForm next={next} />;
}
