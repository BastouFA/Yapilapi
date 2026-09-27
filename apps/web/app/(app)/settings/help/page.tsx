'use client';

import { AboutCard, LegalListCard, ProblemCard } from '@/components/settings/Help';
import { SettingsPage } from '@/components/settings/Shell';

/** Help and legal: report a problem, every policy, and which version this is. */
export default function HelpSettings() {
  return (
    <SettingsPage section="help">
      <ProblemCard />
      <LegalListCard />
      <AboutCard />
    </SettingsPage>
  );
}
