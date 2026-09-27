'use client';

import { FamilyCard } from '@/components/Family';
import { ModerationCard, RestrictedCard, SensitiveCard } from '@/components/settings/Safety';
import { Anchor, SettingsPage } from '@/components/settings/Shell';

/** Safety: family supervision, restricted people, sensitive content, and decisions about your content. */
export default function SafetySettings() {
  return (
    <SettingsPage section="safety">
      <Anchor id="family">
        <FamilyCard />
      </Anchor>
      <RestrictedCard />
      <SensitiveCard />
      <ModerationCard />
    </SettingsPage>
  );
}
