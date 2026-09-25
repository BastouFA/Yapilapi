import { Guard } from '@/components/Gate';
import { IdentityView } from '@/views/Identity';

export default function Page() {
  return (
    <Guard minRole="moderator">
      <IdentityView />
    </Guard>
  );
}
