import { InboxShell } from '@/components/chat/InboxShell';

export default function InboxLayout({ children }: { children: React.ReactNode }) {
  return <InboxShell>{children}</InboxShell>;
}
