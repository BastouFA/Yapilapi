import { Guard } from '@/components/Gate';
import { ReportsView } from '@/views/ModerationLists';

export default function Page() {
  return (
    <Guard permission="reports.read">
      <ReportsView />
    </Guard>
  );
}
