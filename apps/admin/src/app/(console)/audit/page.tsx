import { Guard } from '@/components/Gate';
import { AuditView } from '@/views/Audit';

export default function Page() {
  return (
    <Guard permission="audit.read">
      <AuditView />
    </Guard>
  );
}
