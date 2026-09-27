'use client';

import { FeedCard } from '@/components/settings/Notifications';
import { SettingsPage } from '@/components/settings/Shell';

/** Feed and time: friends only, fewer suggestions, focus and quiet modes, a daily time budget. */
export default function FeedSettings() {
  return (
    <SettingsPage section="feed">
      <FeedCard />
    </SettingsPage>
  );
}
