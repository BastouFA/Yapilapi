import { ChannelView } from '@/components/communities/ChannelView';

export default async function ChannelPage({
  params,
}: {
  params: Promise<{ id: string; cid: string }>;
}) {
  const { id, cid } = await params;
  return <ChannelView idOrSlug={decodeURIComponent(id)} channelId={cid} />;
}
