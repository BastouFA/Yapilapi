import { CommunityView } from '@/components/communities/CommunityView';

export default async function CommunityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CommunityView idOrSlug={decodeURIComponent(id)} />;
}
