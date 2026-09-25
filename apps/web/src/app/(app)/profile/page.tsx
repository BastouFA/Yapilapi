import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/server-session';

/** Shortcut to your own profile. */
export default async function MyProfilePage() {
  const s = await getServerSession();
  if (s.status === 'ok') redirect(`/u/${encodeURIComponent(s.me.user.profile.username)}`);
  redirect('/login?next=%2Fprofile');
}
