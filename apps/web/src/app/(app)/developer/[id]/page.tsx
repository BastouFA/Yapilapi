import { DeveloperAppDetailView } from '@/components/developer/DeveloperAppDetailView';

export default async function DeveloperAppDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DeveloperAppDetailView id={decodeURIComponent(id)} />;
}
