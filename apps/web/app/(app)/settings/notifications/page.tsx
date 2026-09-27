'use client';

import { BrowserPushCard, CategoriesCard, PauseCard, QuietHoursCard } from '@/components/settings/Notifications';
import { SettingsPage } from '@/components/settings/Shell';

/** Notifications: on this browser, pausing, quiet hours, and which kinds you get. */
export default function NotificationSettings() {
  return (
    <SettingsPage section="notifications">
      <BrowserPushCard />
      <PauseCard />
      <QuietHoursCard />
      <CategoriesCard />
    </SettingsPage>
  );
}
