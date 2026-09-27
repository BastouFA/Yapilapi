'use client';

import { TranslationCard } from '@/components/TranslationSettings';
import { LanguageCard } from '@/components/settings/Language';
import { Anchor, SettingsPage } from '@/components/settings/Shell';

/** Language and translation: the app's language, your country, and "See translation". */
export default function LanguageSettings() {
  return (
    <SettingsPage section="language">
      <LanguageCard />
      <Anchor id="translation">
        <TranslationCard />
      </Anchor>
    </SettingsPage>
  );
}
