'use client';

import { BrowserPushCard, CategoriesCard, PauseCard, QuietHoursCard, TodaySettingsCard, WeeklyWrapCard } from '@/components/settings/Notifications';
import { SettingsPage } from '@/components/settings/Shell';

/** Notifications: on this browser, pausing, quiet hours, which kinds you get, the weekly wrap and Yapilapi Today. */
export default function NotificationSettings() {
  return (
    <SettingsPage section="notifications">
      <BrowserPushCard />
      <PauseCard />
      <QuietHoursCard />
      <CategoriesCard />
      <WeeklyWrapCard />
      <TodaySettingsCard />
    </SettingsPage>
  );
}
