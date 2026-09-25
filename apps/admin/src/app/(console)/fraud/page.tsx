import { Guard } from '@/components/Gate';
import { FraudView } from '@/views/Fraud';

export default function Page() {
  return (
    <Guard permission="fraud.read">
      <FraudView />
    </Guard>
  );
}
