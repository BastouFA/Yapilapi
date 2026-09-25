import { Guard } from '@/components/Gate';
import { MiniAppsView } from '@/views/MiniApps';

export default function Page() {
  return (
    <Guard permission="miniapps.review">
      <MiniAppsView />
    </Guard>
  );
}
