import { EventDetailView } from '@/components/events/EventDetailView';

export default async function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EventDetailView id={decodeURIComponent(id)} />;
}
