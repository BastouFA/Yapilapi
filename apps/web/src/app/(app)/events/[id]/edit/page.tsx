import { EventEditView } from '@/components/events/EventEditView';

export default async function EventEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EventEditView id={decodeURIComponent(id)} />;
}
