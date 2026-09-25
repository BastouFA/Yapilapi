import { ProfileView } from '@/components/profile/ProfileView';

export default async function ProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  return <ProfileView username={decodeURIComponent(username)} />;
}
