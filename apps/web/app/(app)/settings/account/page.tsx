'use client';

import { ProfileCard, SignInDetailsCard } from '@/components/settings/Account';
import { Anchor, SettingsPage } from '@/components/settings/Shell';
import { VerificationCard } from '@/components/Verification';

/** Account: your profile, email and phone (with whether they're confirmed), username and date of birth. */
export default function AccountSettings() {
  return (
    <SettingsPage section="account">
      <ProfileCard />
      <Anchor id="verification">
        <VerificationCard />
      </Anchor>
      <SignInDetailsCard />
    </SettingsPage>
  );
}
