import type { Metadata } from 'next';
import { getPublicCommunity } from '@/lib/public';
import { communityMetadata, privateMetadata } from '@/lib/metadata';
import CommunityPageClient from './PageClient';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const community = await getPublicCommunity(slug);
  return community ? communityMetadata(community) : privateMetadata('Community');
}

export default async function CommunityPage({ params }: Props) {
  const { slug } = await params;
  return <CommunityPageClient isPublic={!!(await getPublicCommunity(slug))} />;
}
