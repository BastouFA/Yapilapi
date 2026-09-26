import { OG_CONTENT_TYPE, OG_SIZE } from '@/lib/og';
import { eventShareImage } from '@/lib/share-images';

export const alt = 'An event on YAPILAPI';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  return eventShareImage((await params).id);
}
