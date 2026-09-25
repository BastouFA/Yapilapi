import { notFound } from 'next/navigation';
import { SettingsView } from '@/components/settings/SettingsView';
import { SETTINGS_SECTIONS, type SettingsSection } from '@/components/settings/sections';

export default async function SettingsPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  if (!(SETTINGS_SECTIONS as readonly string[]).includes(section)) notFound();
  return <SettingsView section={section as SettingsSection} />;
}
