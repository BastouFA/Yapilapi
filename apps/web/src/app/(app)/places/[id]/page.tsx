import { PlaceDetailView } from '@/components/places/PlaceDetailView';

export default async function PlaceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PlaceDetailView id={decodeURIComponent(id)} />;
}
