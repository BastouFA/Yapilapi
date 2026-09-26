import type { Metadata } from 'next';
import { getPublicEvent } from '@/lib/public';
import { eventMetadata, privateMetadata } from '@/lib/metadata';
import EventPageClient from './PageClient';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const event = await getPublicEvent(id);
  return event ? eventMetadata(event) : privateMetadata('Event');
}

export default async function EventPage({ params }: Props) {
  const { id } = await params;
  return <EventPageClient isPublic={!!(await getPublicEvent(id))} />;
}
