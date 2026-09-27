'use client';

import { HiddenWordsCard } from '@/components/HiddenWords';
import {
  AiHelpersCard,
  AudiencesCard,
  BlockedCard,
  DataUseCard,
  MemoryCard,
  MutedCard,
  PrivateAccountCard,
  ReachCard,
  SharingCard,
} from '@/components/settings/Privacy';
import { Anchor, SettingsPage } from '@/components/settings/Shell';

/**
 * Privacy: a private account, who can reach you, close friends and circles, blocked and muted
 * people, hidden words, being found and downloads, and how your data is used.
 */
export default function PrivacySettings() {
  return (
    <SettingsPage section="privacy">
      <PrivateAccountCard />
      <ReachCard />
      <AudiencesCard />
      <BlockedCard />
      <MutedCard />
      <Anchor id="hidden-words">
        <HiddenWordsCard />
      </Anchor>
      <SharingCard />
      <DataUseCard />
      <AiHelpersCard />
      <MemoryCard />
    </SettingsPage>
  );
}
