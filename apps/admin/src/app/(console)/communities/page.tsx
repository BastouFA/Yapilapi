import { Guard } from '@/components/Gate';
import { CommunitiesView } from '@/views/Communities';

export default function Page() {
  return (
    <Guard permission="communities.read">
      <CommunitiesView />
    </Guard>
  );
}
