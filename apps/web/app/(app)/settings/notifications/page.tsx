'use client';

import { BrowserPushCard, CategoriesCard, PauseCard, QuietHoursCard, WeeklyWrapCard } from '@/components/settings/Notifications';
import { SettingsPage } from '@/components/settings/Shell';

/** Notifications: on this browser, pausing, quiet hours, which kinds you get, and the weekly wrap. */
export default function NotificationSettings() {
  return (
    <SettingsPage section="notifications">
      <BrowserPushCard />
      <PauseCard />
      <QuietHoursCard />
      <CategoriesCard />
      <WeeklyWrapCard />
    </SettingsPage>
  );
}
