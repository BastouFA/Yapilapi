import { notFound } from 'next/navigation';
import { Guard } from '@/components/Gate';
import { UserDetailView } from '@/views/UserDetail';
import { isUuid } from '@/lib/ids';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  return (
    <Guard permission="users.read">
      <UserDetailView id={id} />
    </Guard>
  );
}
