'use client';

import { ChangePasswordCard } from '@/components/settings/Account';
import { ActivityCard, ConnectedAppsCard, PasskeysCard, SessionsCard, TwoStepCard } from '@/components/settings/Security';
import { SettingsPage } from '@/components/settings/Shell';

/**
 * Security and login: password, two-step verification, passkeys, where you're signed in (log out
 * one device or all of them), recent sign-ins and changes, and apps connected to your account.
 */
export default function SecuritySettings() {
  return (
    <SettingsPage section="security">
      <ChangePasswordCard />
      <TwoStepCard />
      <PasskeysCard />
      <SessionsCard />
      <ActivityCard />
      <ConnectedAppsCard />
    </SettingsPage>
  );
}
