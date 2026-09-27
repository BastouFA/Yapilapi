import { LegalShell } from '@/components/Legal';

/** /legal and every policy under it: public, readable without an account. */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return <LegalShell>{children}</LegalShell>;
}
