import { Guard } from '@/components/Gate';
import { AiUsageView } from '@/views/AiUsage';

export default function Page() {
  return (
    <Guard permission="ai.read">
      <AiUsageView />
    </Guard>
  );
}
