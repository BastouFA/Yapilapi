'use client';

import { useId, useState } from 'react';
import { Icon } from '@yapilapi/design-system';
import { SUPPORTED_LOCALES, TRANSLATION_LANGUAGES } from '@yapilapi/shared';
import { useSession } from '@/app/providers';

/** Each language by its own name ("Français", "العربية"), the same on the server and in every browser. */
function autonym(code: string): string {
  return TRANSLATION_LANGUAGES.find((l) => l.code === code)?.autonym ?? code;
}

/**
 * The site's language for someone without an account (landing, log in, sign up, shared pages).
 * Switches in place and is remembered on this browser; signing up makes it the account's language.
 * Nothing for a signed-in reader, whose language is in Settings.
 */
export function LanguagePicker({ className }: { className?: string }) {
  const { me, locale, chooseLocale, t } = useSession();
  const id = useId();
  // The language just picked, shown while it loads.
  const [picked, setPicked] = useState<string | null>(null);
  if (me) return null;
  const current = picked ?? (SUPPORTED_LOCALES.includes(locale.split('-')[0]!) ? locale.split('-')[0]! : 'en');
  return (
    <div className={['lang-pick', className].filter(Boolean).join(' ')}>
      <Icon name="globe" size={18} />
      <label htmlFor={id} className="yp-visually-hidden">
        {t('settings.language')}
      </label>
      <select
        id={id}
        className="lang-pick__select"
        value={current}
        onChange={(e) => {
          const code = e.currentTarget.value;
          setPicked(code);
          void chooseLocale(code).finally(() => setPicked(null));
        }}
      >
        {SUPPORTED_LOCALES.map((code) => (
          <option key={code} value={code} lang={code}>
            {autonym(code)}
          </option>
        ))}
      </select>
    </div>
  );
}
