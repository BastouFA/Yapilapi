import Link from 'next/link';
import { LanguagePicker } from '@/components/LanguagePicker';
import { LegalLinks } from '@/components/Legal';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth" id="main">
      <div className="auth__card">
        <div className="auth__top">
          <Link href="/" className="auth__brand">
            <img src="/mark.svg" alt="" width={28} height={28} />
            YAPILAPI
          </Link>
          <LanguagePicker />
        </div>
        {children}
        <LegalLinks className="site-legal" />
      </div>
    </main>
  );
}
