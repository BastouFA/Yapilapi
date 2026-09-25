import { Guard } from '@/components/Gate';
import { AppealsView } from '@/views/ModerationLists';

export default function Page() {
  return (
    <Guard permission="appeals.review">
      <AppealsView />
    </Guard>
  );
}
