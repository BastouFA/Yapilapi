import type { Metadata, Viewport } from 'next';
import { YapShell } from '@/components/YapShell';

// Yap mode installs as its own app ("Yap") on a phone's home screen or a computer's dock:
// its own manifest, scoped to /yap, so it opens straight into your chats.
export const metadata: Metadata = {
  title: { default: 'Yap', template: '%s · Yap' },
  manifest: '/yap.webmanifest',
  appleWebApp: { capable: true, title: 'Yap', statusBarStyle: 'default' },
  icons: { apple: '/yap-icon-180.png' },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#EFEBE6' },
    { media: '(prefers-color-scheme: dark)', color: '#0B0C14' },
  ],
};

export default function YapLayout({ children }: { children: React.ReactNode }) {
  return <YapShell>{children}</YapShell>;
}
