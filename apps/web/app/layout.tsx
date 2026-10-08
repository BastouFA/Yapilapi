import type { Metadata, Viewport } from 'next';
import { Bricolage_Grotesque, Figtree, JetBrains_Mono } from 'next/font/google';
import '@yapilapi/design-system/tokens.css';
import '@yapilapi/design-system/components.css';
import '@yapilapi/design-system/social.css';
import './globals.css';
import './settings.css';
import './watch.css';
import './echo.css';
import './mic.css';
import './squads.css';
import './yaps.css';
import './radio.css';
import './tickets.css';
import './market.css';
import './citymap.css';
import './askcity.css';
import { Providers } from './providers';
import { LOCALE_SCRIPT } from '@/lib/locale-script';
import { THEME_SCRIPT } from '@/lib/theme-script';

// Fonts are downloaded when the app is built and served from our own domain: visitors' browsers never contact Google.
const sans = Figtree({ subsets: ['latin', 'latin-ext'], variable: '--font-figtree', display: 'swap' });
const display = Bricolage_Grotesque({ subsets: ['latin', 'latin-ext'], axes: ['opsz'], variable: '--font-bricolage', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin', 'latin-ext'], weight: '400', variable: '--font-jetbrains-mono', display: 'swap' });

// The same words as lib/metadata.ts's SITE_DESCRIPTION and the landing page.
const SITE_DESCRIPTION = 'Speak. The world understands. YAPILAPI is the social network you speak: hold to talk, and be heard in 24 languages.';

const SITE_URL = (process.env.SITE_URL || process.env.WEB_ORIGIN?.split(',')[0] || 'http://localhost:3000').replace(/\/+$/, '');

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: 'YAPILAPI: the social network you speak', template: '%s · YAPILAPI' },
  description: SITE_DESCRIPTION,
  applicationName: 'YAPILAPI',
  // "Add to Home Screen" installs YAPILAPI with its own icon (Yap mode has its own: app/(app)/yap/layout.tsx).
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'YAPILAPI', statusBarStyle: 'default' },
  icons: { apple: '/yapilapi-icon-180.png' },
  openGraph: { siteName: 'YAPILAPI', type: 'website', title: 'YAPILAPI: the social network you speak', description: SITE_DESCRIPTION },
  twitter: { card: 'summary_large_image', title: 'YAPILAPI: the social network you speak', description: SITE_DESCRIPTION },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#EFEBE6' },
    { media: '(prefers-color-scheme: dark)', color: '#0B0C14' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${display.variable} ${mono.variable}`}>
      <head>
        {/* A chosen Light or Dark appearance applies before the first paint (lib/theme.ts). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* So does a returning reader's language and its direction (lib/locale-script.ts). */}
        <script dangerouslySetInnerHTML={{ __html: LOCALE_SCRIPT }} />
      </head>
      <body className="yp-root">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
