import { notFound } from 'next/navigation';
import { Guard } from '@/components/Gate';
import { AnalyticsView, isAnalyticsTab } from '@/views/Analytics';

export default async function Page({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params;
  if (!isAnalyticsTab(tab)) notFound();
  return (
    <Guard permission="analytics.read">
      <AnalyticsView tab={tab} />
    </Guard>
  );
}
