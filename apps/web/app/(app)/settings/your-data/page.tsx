'use client';

import { SettingsPage } from '@/components/settings/Shell';
import { DeleteAccountCard, DownloadCard, HeldCard } from '@/components/settings/YourData';

/** Your data: what we hold about you, a copy to download, and deleting your account. */
export default function YourDataSettings() {
  return (
    <SettingsPage section="your-data">
      <HeldCard />
      <DownloadCard />
      <DeleteAccountCard />
    </SettingsPage>
  );
}
