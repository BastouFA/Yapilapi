import Link from 'next/link';
import { LegalLinks } from '@/components/Legal';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth" id="main">
      <div className="auth__card">
        <Link href="/" className="auth__brand">
          <img src="/mark.svg" alt="" width={28} height={28} />
          YAPILAPI
        </Link>
        {children}
        <LegalLinks className="site-legal" />
      </div>
    </main>
  );
}
