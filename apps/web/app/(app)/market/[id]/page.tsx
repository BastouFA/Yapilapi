import type { Metadata } from 'next';
import { getPublicListing } from '@/lib/public';
import { listingMetadata, privateMetadata } from '@/lib/metadata';
import ListingPageClient from './PageClient';

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const listing = await getPublicListing(id);
  return listing ? listingMetadata(listing) : privateMetadata('Market');
}

export default async function ListingPage({ params }: Props) {
  const { id } = await params;
  return <ListingPageClient preview={await getPublicListing(id)} />;
}
