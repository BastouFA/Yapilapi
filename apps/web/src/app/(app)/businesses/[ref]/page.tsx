import { BusinessProfileView } from '@/components/business/BusinessProfileView';

export default async function BusinessProfilePage({
  params,
}: {
  params: Promise<{ ref: string }>;
}) {
  const { ref } = await params;
  return <BusinessProfileView ref={decodeURIComponent(ref)} />;
}
