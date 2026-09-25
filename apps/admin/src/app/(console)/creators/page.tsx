import { Guard } from '@/components/Gate';
import { CreatorsView } from '@/views/Creators';

export default function Page() {
  return (
    <Guard permission="creators.read">
      <CreatorsView />
    </Guard>
  );
}
