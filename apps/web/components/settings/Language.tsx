'use client';

import { useState } from 'react';
import { Button, Card, Select } from '@yapilapi/design-system';
import { loadLocale, SUPPORTED_LOCALES, t as translate } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import { Anchor } from './Shell';

/** The app's language and your country (some content can be unavailable in some countries). */
export function LanguageCard() {
  const { me, refresh, toast, locale, t } = useSession();
  const [busy, setBusy] = useState(false);
  if (!me) return null;
  return (
    <Anchor id="language">
      <Card title={t('settings.language')} subtitle={t('st.language.appHint')}>
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const chosen = String(f.get('locale'));
            const country = f.get('country') ? String(f.get('country')) : null;
            setBusy(true);
            // Fetch the new language while the choice saves; refresh() waits for it before switching.
            void loadLocale(chosen);
            try {
              await api.me.updateProfile({
                locale: chosen,
                // Only when changed: saving the language mustn't turn a detected country into a chosen one.
                ...(country !== (me.country ?? null) ? { country } : {}),
              });
              const saved = await refresh();
              // In the language just chosen, not the one the page was showing.
              toast(translate('st.language.saved', saved?.locale ?? locale));
            } catch (err) {
              toast(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Select label={t('settings.language')} name="locale" defaultValue={me.locale ?? 'en'}>
            {SUPPORTED_LOCALES.map((l) => (
              <option key={l} value={l} lang={l}>
                {new Intl.DisplayNames([l], { type: 'language' }).of(l)}
              </option>
            ))}
          </Select>
          <Select label={t('settings.country')} name="country" defaultValue={me.country ?? ''} hint={t('settings.countryHint')}>
            <option value="">{t('settings.notSet')}</option>
            {countries(locale).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </Select>
          <div>
            <Button type="submit" loading={busy}>
              {t('common.save')}
            </Button>
          </div>
        </form>
      </Card>
    </Anchor>
  );
}

const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ', 'XX']);
/** ISO 3166-1 alpha-2 regions the browser can name, sorted by name in the viewer's language. */
function countries(locale: string): [string, string][] {
  const names = new Intl.DisplayNames([locale], { type: 'region', fallback: 'none' });
  const out: [string, string][] = [];
  for (let a = 65; a <= 90; a++)
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (NOT_COUNTRIES.has(code)) continue;
      let name: string | undefined;
      try {
        name = names.of(code);
      } catch {}
      if (name && name !== code) out.push([code, name]);
    }
  return out.sort((x, y) => x[1].localeCompare(y[1], locale));
}
