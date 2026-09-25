import { Guard } from '@/components/Gate';
import { FlagsView } from '@/views/Flags';

export default function Page() {
  return (
    <Guard permission="flags.read">
      <FlagsView />
    </Guard>
  );
}
