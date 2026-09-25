import { Guard } from '@/components/Gate';
import { BusinessesView } from '@/views/Businesses';

export default function Page() {
  return (
    <Guard permission="businesses.read">
      <BusinessesView />
    </Guard>
  );
}
