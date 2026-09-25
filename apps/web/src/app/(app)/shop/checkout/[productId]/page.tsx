import { CheckoutView } from '@/components/commerce/CheckoutView';

export default async function CheckoutPage({ params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params;
  return <CheckoutView productId={decodeURIComponent(productId)} />;
}
