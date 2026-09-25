import React from 'react';
import { useTheme } from '../../theme';
import { useI18n } from '../../i18n';
import { LOCALES, LOCALE_NAMES, type Locale } from '../../i18n/core';
import { usePrefs } from '../../prefs';
import { useSaveLocaleToAccount } from '../../data/settings';
import { AppText, ChoiceGroup, Screen } from '../../ui';

export default function LanguageAndDisplay() {
  const th = useTheme();
  const { t, locale } = useI18n();
  const { prefs, setPrefs, needsRestart } = usePrefs();
  const saveToAccount = useSaveLocaleToAccount();
  return (
    <Screen scroll>
      <ChoiceGroup<Locale>
        label={t('language.language')}
        value={locale}
        options={LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))}
        onChange={(l) => {
          setPrefs({ locale: l });
          saveToAccount(l);
        }}
      />
      {locale !== 'en' ? (
        <AppText variant="caption" tone="muted" style={{ marginBottom: th.space[3] }}>
          {t('language.draftNote')}
        </AppText>
      ) : null}
      {needsRestart ? (
        <AppText
          variant="caption"
          tone="warning"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={{ marginBottom: th.space[4] }}
        >
          {t('language.restart')}
        </AppText>
      ) : null}
      <ChoiceGroup
        label={t('language.theme')}
        value={prefs.theme}
        options={(['system', 'light', 'dark'] as const).map((v) => ({
          value: v,
          label: t(`language.theme.${v}`),
        }))}
        onChange={(v) => setPrefs({ theme: v })}
      />
      <ChoiceGroup
        label={t('language.motion')}
        value={prefs.motion}
        options={(['system', 'reduce', 'full'] as const).map((v) => ({
          value: v,
          label: t(`language.motion.${v}`),
        }))}
        onChange={(v) => setPrefs({ motion: v })}
      />
      <ChoiceGroup
        label={t('language.bandwidth')}
        value={prefs.bandwidth}
        options={(['auto', 'low', 'normal'] as const).map((v) => ({
          value: v,
          label: t(`language.bandwidth.${v}`),
        }))}
        onChange={(v) => setPrefs({ bandwidth: v })}
      />
      <AppText variant="caption" tone="muted">
        {t('language.bandwidthHint')}
      </AppText>
    </Screen>
  );
}
