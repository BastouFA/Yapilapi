import { MomentViewer } from '@/components/moments/MomentViewer';

export default async function MomentViewerPage({
  params,
}: {
  params: Promise<{ username: string }>;
}) {
  const { username } = await params;
  return <MomentViewer username={decodeURIComponent(username)} />;
}
