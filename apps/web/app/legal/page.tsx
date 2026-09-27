import type { Metadata } from 'next';
import { LegalIndex } from '@/components/Legal';
import { siteOrigin } from '@/lib/public';

export async function generateMetadata(): Promise<Metadata> {
  return {
    metadataBase: new URL(await siteOrigin()),
    title: 'Legal and policies',
    description: 'The rules for using YAPILAPI, and how YAPILAPI handles your information.',
    alternates: { canonical: '/legal' },
  };
}

export default function LegalPage() {
  return <LegalIndex />;
}
