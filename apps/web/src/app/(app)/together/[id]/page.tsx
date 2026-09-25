import { TogetherDetailView } from '@/components/together/TogetherDetailView';

export default async function TogetherDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TogetherDetailView id={decodeURIComponent(id)} />;
}
