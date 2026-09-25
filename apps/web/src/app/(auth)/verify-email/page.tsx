import { VerifyEmail } from '@/components/auth/VerifyEmail';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const sp = await searchParams;
  return <VerifyEmail token={typeof sp.token === 'string' ? sp.token : ''} />;
}
