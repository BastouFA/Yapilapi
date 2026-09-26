import type { Metadata } from 'next';
import { getPublicPost } from '@/lib/public';
import { postMetadata, privateMetadata } from '@/lib/metadata';
import ReelsPageClient from './PageClient';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function startOf(sp: Record<string, string | string[] | undefined>): string | null {
  const v = sp.start;
  return typeof v === 'string' && v ? v : null;
}

/** A shared reel (/reels?start=:id) previews as that reel, with its poster frame and video. */
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const start = startOf(await searchParams);
  const post = start ? await getPublicPost(start) : null;
  if (post) return postMetadata(post, `/reels?start=${post.id}`, true);
  return start ? privateMetadata('Reels') : { title: 'Reels' };
}

export default async function ReelsPage({ searchParams }: Props) {
  const start = startOf(await searchParams);
  const post = start ? await getPublicPost(start) : null;
  return <ReelsPageClient start={start} isPublic={!!post} />;
}
