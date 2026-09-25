import { MemoryDetailView } from '@/components/memory/MemoryDetailView';

export default async function MemoryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MemoryDetailView id={decodeURIComponent(id)} />;
}
