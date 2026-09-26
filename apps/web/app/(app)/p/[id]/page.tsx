import type { Metadata } from 'next';
import { getPublicPost } from '@/lib/public';
import { postMetadata, privateMetadata } from '@/lib/metadata';
import PostPageClient from './PageClient';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const post = await getPublicPost(id);
  return post ? postMetadata(post, `/p/${post.id}`) : privateMetadata('Post');
}

export default async function PostPage({ params }: Props) {
  const { id } = await params;
  return <PostPageClient isPublic={!!(await getPublicPost(id))} />;
}
