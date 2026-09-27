'use client';

import { ChangePasswordCard } from '@/components/settings/Account';
import { ActivityCard, ConnectedAppsCard, PasskeysCard, SessionsCard, SignInAlertsCard, SignInReview, TwoStepCard } from '@/components/settings/Security';
import { SettingsPage } from '@/components/settings/Shell';

/**
 * Security and login: where you're signed in (log out one device or all of them), password,
 * two-step verification, passkeys, sign-in alerts, recent sign-ins and changes, and apps
 * connected to your account.
 */
export default function SecuritySettings() {
  return (
    <SettingsPage section="security">
      {/* "This wasn't me" in a sign-in alert opens here: what to do, then the devices to log out. */}
      <SignInReview />
      <SessionsCard />
      <ChangePasswordCard />
      <TwoStepCard />
      <PasskeysCard />
      <SignInAlertsCard />
      <ActivityCard />
      <ConnectedAppsCard />
    </SettingsPage>
  );
}
