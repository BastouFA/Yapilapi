import { Guard } from '@/components/Gate';
import { PaymentsView } from '@/views/Payments';

export default function Page() {
  return (
    <Guard permission="payments.read">
      <PaymentsView tab="overview" />
    </Guard>
  );
}
