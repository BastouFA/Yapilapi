import type { Metadata, Viewport } from 'next';
import { cookies, headers } from 'next/headers';
import '@yapilapi/design-system/tokens.css';
import '@yapilapi/design-system/base.css';
import '@yapilapi/ui/styles.css';
import './admin.css';
import { Providers } from '@/components/Providers';
import { getPublicApiUrl } from '@/lib/env';
import { directionOf, isLocale, LOCALE_COOKIE, negotiateLocale } from '@/i18n/core';

export const metadata: Metadata = {
  title: { default: 'YAPILAPI Console', template: '%s · YAPILAPI Console' },
  description: 'YAPILAPI staff console.',
  applicationName: 'YAPILAPI Console',
  robots: { index: false, follow: false },
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
  const theme = jar.get('yl_admin_theme')?.value;
  const saved = jar.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(saved)
    ? saved
    : negotiateLocale((await headers()).get('accept-language'));
  return (
    <html
      lang={locale}
      dir={directionOf(locale)}
      suppressHydrationWarning
      {...(theme === 'light' || theme === 'dark' ? { 'data-theme': theme } : {})}
    >
      <body>
        <Providers apiUrl={getPublicApiUrl()} locale={locale}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
