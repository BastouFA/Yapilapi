import { notFound } from 'next/navigation';
import { Guard } from '@/components/Gate';
import { PAYMENT_TABS, PaymentsView } from '@/views/Payments';

export default async function Page({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params;
  const found = PAYMENT_TABS.find((t) => t === tab);
  if (!found || found === 'overview') notFound();
  // Everything except the overview is the finance queue (the API allows admins and above).
  return (
    <Guard permission="payments.read" minRole="admin">
      <PaymentsView tab={found} />
    </Guard>
  );
}
