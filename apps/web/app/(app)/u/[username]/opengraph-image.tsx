import { OG_CONTENT_TYPE, OG_SIZE } from '@/lib/og';
import { profileShareImage } from '@/lib/share-images';

export const alt = 'A profile on YAPILAPI';
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function Image({ params }: { params: Promise<{ username: string }> }) {
  return profileShareImage((await params).username);
}
