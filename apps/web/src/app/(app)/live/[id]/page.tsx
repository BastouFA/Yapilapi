import { SessionRoomView } from '@/components/live/SessionRoomView';

export default async function LiveSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SessionRoomView id={decodeURIComponent(id)} />;
}
