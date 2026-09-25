import type { Metadata, Viewport } from 'next';
import { cookies, headers } from 'next/headers';
import { directionFor } from '@yapilapi/design-system';
import '@yapilapi/design-system/tokens.css';
import '@yapilapi/design-system/base.css';
import '@yapilapi/ui/styles.css';
import './app.css';
import { Providers } from '@/components/Providers';
import { getPublicApiUrl } from '@/lib/env';
import { parsePrefs } from '@/lib/prefs-shared';
import { negotiateLocale } from '@/i18n/core';

export const metadata: Metadata = {
  title: { default: 'YAPILAPI', template: '%s · YAPILAPI' },
  description: 'YAPILAPI. Your social world. One place.',
  applicationName: 'YAPILAPI',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbf7f0' },
    { media: '(prefers-color-scheme: dark)', color: '#16110d' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const jar = await cookies();
  const h = await headers();
  const prefs = parsePrefs((n) => jar.get(n)?.value, negotiateLocale(h.get('accept-language')));
  return (
    <html
      lang={prefs.locale}
      dir={directionFor(prefs.locale)}
      suppressHydrationWarning
      {...(prefs.theme !== 'system' ? { 'data-theme': prefs.theme } : {})}
      {...(prefs.motion !== 'system' ? { 'data-motion': prefs.motion } : {})}
      {...(prefs.contrast !== 'system' ? { 'data-contrast': prefs.contrast } : {})}
      {...(prefs.bandwidth === 'low' ? { 'data-bandwidth': 'low' } : {})}
    >
      <body>
        <Providers initialPrefs={prefs} apiUrl={getPublicApiUrl()}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
