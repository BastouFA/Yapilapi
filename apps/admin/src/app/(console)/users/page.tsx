import { Guard } from '@/components/Gate';
import { UsersView } from '@/views/Users';

export default function Page() {
  return (
    <Guard permission="users.read">
      <UsersView />
    </Guard>
  );
}
