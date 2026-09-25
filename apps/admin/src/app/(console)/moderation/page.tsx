import { Guard } from '@/components/Gate';
import { ModerationQueueView } from '@/views/ModerationQueue';

export default function Page() {
  return (
    <Guard permission="cases.read">
      <ModerationQueueView />
    </Guard>
  );
}
