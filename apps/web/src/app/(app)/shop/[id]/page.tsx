import { ProductDetailView } from '@/components/commerce/ProductDetailView';

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProductDetailView id={decodeURIComponent(id)} />;
}
