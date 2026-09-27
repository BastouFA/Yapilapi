'use client';

import { DataSaverCard } from '@/components/DataSaver';
import { SettingsPage } from '@/components/settings/Shell';

export default function DataSaverSettings() {
  return (
    <SettingsPage section="data-saver">
      <div id="data-saver">
        <DataSaverCard />
      </div>
    </SettingsPage>
  );
}
