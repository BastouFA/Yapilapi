'use client';

import { useRouter } from 'next/navigation';
import { useI18n } from '@/i18n';
import { isLocale, LOCALE_COOKIE, LOCALE_NAMES, LOCALES } from '@/i18n/core';

/** Interface language. Stored in a cookie so the server renders the right language and direction with no flash. */
export function LocaleSwitch() {
  const { t, locale } = useI18n();
  const router = useRouter();
  return (
    <label className="theme-switch">
      <span className="yl-sr-only">{t('locale.label')}</span>
      <select
        className="yl-input yl-select theme-switch__select"
        value={locale}
        onChange={(e) => {
          if (!isLocale(e.target.value)) return;
          document.cookie = `${LOCALE_COOKIE}=${e.target.value}; path=/; max-age=31536000; samesite=lax`;
          router.refresh();
        }}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l} lang={l}>
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
