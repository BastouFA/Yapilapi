import { ResetPasswordForm } from '@/components/auth/ResetPasswordForm';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const sp = await searchParams;
  return <ResetPasswordForm token={typeof sp.token === 'string' ? sp.token : ''} />;
}
