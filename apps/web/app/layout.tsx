import type { Metadata, Viewport } from 'next';
import '@yapilapi/design-system/tokens.css';
import '@yapilapi/design-system/components.css';
import '@yapilapi/design-system/social.css';
import './globals.css';
import { Providers } from './providers';

const SITE_URL = (process.env.SITE_URL || process.env.WEB_ORIGIN?.split(',')[0] || 'http://localhost:3000').replace(/\/+$/, '');

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: 'YAPILAPI', template: '%s · YAPILAPI' },
  description: 'Your social world. One place.',
  applicationName: 'YAPILAPI',
  openGraph: { siteName: 'YAPILAPI', type: 'website', title: 'YAPILAPI', description: 'Your social world. One place.' },
  twitter: { card: 'summary_large_image', title: 'YAPILAPI', description: 'Your social world. One place.' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F4F5FA' },
    { media: '(prefers-color-scheme: dark)', color: '#0B0C14' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Figtree:wght@400;500;600;700&family=Inter:wght@400;700&family=JetBrains+Mono:wght@400&display=swap"
        />
      </head>
      <body className="yp-root">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
