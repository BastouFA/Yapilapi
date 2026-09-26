import { postShareImage } from '@/lib/share-images';

/**
 * A post's share image at a stable address, for pages that show a post but
 * aren't the post's own page (a reel opened in Reels, /reels?start=:id).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return postShareImage((await params).id);
}
