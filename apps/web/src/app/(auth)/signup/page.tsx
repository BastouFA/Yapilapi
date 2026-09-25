import { redirect } from 'next/navigation';
import { SignupWizard } from '@/components/auth/SignupWizard';
import { getServerSession } from '@/lib/server-session';

export default async function SignupPage() {
  const session = await getServerSession();
  if (session.status === 'ok') {
    // Signed in and finished: nothing to do here. Signed in but mid-onboarding: resume after the account is created.
    if (session.me.user.profile.onboardingCompleted) redirect('/');
    return (
      <SignupWizard
        resume={{ username: session.me.user.profile.username, ageBand: session.me.user.ageBand }}
      />
    );
  }
  return <SignupWizard />;
}
