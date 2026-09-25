import { OrderDetailView } from '@/components/commerce/OrderDetailView';

export default async function ShopOrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrderDetailView id={decodeURIComponent(id)} />;
}
