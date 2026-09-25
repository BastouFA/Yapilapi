import { ProjectDetailView } from '@/components/studio/ProjectDetailView';

export default async function StudioProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectDetailView id={decodeURIComponent(id)} />;
}
