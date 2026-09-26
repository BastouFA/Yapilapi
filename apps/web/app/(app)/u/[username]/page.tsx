import type { Metadata } from 'next';
import { getPublicProfile } from '@/lib/public';
import { privateMetadata, profileMetadata } from '@/lib/metadata';
import ProfilePageClient from './PageClient';

type Props = { params: Promise<{ username: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { username } = await params;
  const profile = await getPublicProfile(username);
  return profile ? profileMetadata(profile) : privateMetadata('Profile');
}

export default async function ProfilePage({ params }: Props) {
  const { username } = await params;
  return <ProfilePageClient isPublic={!!(await getPublicProfile(username))} />;
}
