'use client';

import { ProfileCard, SignInDetailsCard } from '@/components/settings/Account';
import { Anchor, SettingsPage } from '@/components/settings/Shell';
import { VerificationCard } from '@/components/Verification';
import { ProfileCustomizeCard } from '@/components/ProfileStyle';

/** Account: your profile (and how it looks: accent, header, links, song, tabs, featured posts), email and phone (with whether they're confirmed), username and date of birth. */
export default function AccountSettings() {
  return (
    <SettingsPage section="account">
      <ProfileCard />
      <Anchor id="customise">
        <ProfileCustomizeCard />
      </Anchor>
      <Anchor id="verification">
        <VerificationCard />
      </Anchor>
      <SignInDetailsCard />
    </SettingsPage>
  );
}
