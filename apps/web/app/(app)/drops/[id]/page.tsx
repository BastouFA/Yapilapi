import type { Metadata } from 'next';
import { getPublicDrop } from '@/lib/public';
import { dropMetadata, privateMetadata } from '@/lib/metadata';
import DropPageClient from './PageClient';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const drop = await getPublicDrop(id);
  return drop ? dropMetadata(drop) : privateMetadata('Drop');
}

export default async function DropPage({ params }: Props) {
  const { id } = await params;
  return <DropPageClient isPublic={!!(await getPublicDrop(id))} />;
}
