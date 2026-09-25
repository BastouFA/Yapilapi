import { Guard } from '@/components/Gate';
import { ContentView } from '@/views/Content';

export default function Page() {
  return (
    <Guard permission="content.read">
      <ContentView />
    </Guard>
  );
}
