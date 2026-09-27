'use client';

import { Card, Checkbox, Switch } from '@yapilapi/design-system';
import { baseLanguage, languageName, MAX_UNDERSTOOD_LANGUAGES, TRANSLATION_LANGUAGES, type TranslationSettings } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

/**
 * Settings: "Languages I understand" (the app's language always counts, so it's
 * ticked and fixed) and "Translate automatically" (off by default). Saved on the
 * account, so every device offers "See translation" the same way.
 */
export function TranslationCard() {
  const { me, setMe, toast, t, locale, flags } = useSession();
  if (!me) return null;
  const app = baseLanguage(locale);
  const settings: TranslationSettings = me.translation ?? { languages: [], auto: false };
  const listed = settings.languages.filter((l) => l !== app);
  const full = listed.length >= MAX_UNDERSTOOD_LANGUAGES;

  const save = async (next: TranslationSettings) => {
    const before = me;
    setMe({ ...me, translation: next });
    try {
      await api.me.setTranslation(next);
    } catch (e) {
      setMe(before);
      toast(errorMessage(e));
    }
  };
  const toggle = (code: string, on: boolean) => void save({ ...settings, languages: on ? [...listed, code] : listed.filter((l) => l !== code) });

  return (
    <Card title={t('translate.settingsTitle')} subtitle={flags.AI_TRANSLATION === false ? t('translate.off') : undefined}>
      <div className="stack">
        <fieldset className="translation-langs" aria-describedby="translation-langs-hint">
          <legend>{t('translate.languages')}</legend>
          <p className="muted setting-hint" id="translation-langs-hint">
            {t('translate.languagesHint', { language: languageName(app, locale) })}
          </p>
          <div className="translation-langs__grid">
            {TRANSLATION_LANGUAGES.map((l) => {
              const isApp = l.code === app;
              const checked = isApp || listed.includes(l.code);
              const local = languageName(l.code, locale);
              return (
                <Checkbox
                  key={l.code}
                  label={<span lang={l.code}>{l.autonym}</span>}
                  description={isApp ? t('translate.appLanguage') : local.toLocaleLowerCase(locale) !== l.autonym.toLocaleLowerCase(locale) ? local : undefined}
                  checked={checked}
                  disabled={isApp || (full && !checked)}
                  onChange={(e) => toggle(l.code, e.currentTarget.checked)}
                />
              );
            })}
          </div>
          {full ? (
            <p className="muted setting-hint" role="status">
              {t('translate.max', { count: MAX_UNDERSTOOD_LANGUAGES })}
            </p>
          ) : null}
        </fieldset>
        <div className="stack-sm">
          <Switch label={t('translate.auto')} checked={settings.auto} onChange={(v) => void save({ ...settings, auto: v })} />
          <p className="muted setting-hint">{t('translate.autoHint')}</p>
        </div>
      </div>
    </Card>
  );
}
