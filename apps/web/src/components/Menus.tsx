'use client';

import { GlobeIcon, IconButton, Menu, MonitorIcon, MoonIcon, SunIcon } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { LOCALES, LOCALE_NAMES } from '@/i18n/core';
import { usePrefs } from '@/lib/prefs';

export function LocaleMenu() {
  const { t } = useI18n();
  const { prefs, setPrefs } = usePrefs();
  return (
    <Menu
      label={t('prefs.language')}
      trigger={
        <IconButton label={t('prefs.language')} icon={<GlobeIcon />} data-testid="locale-menu" />
      }
      items={LOCALES.map((l) => ({
        id: l,
        label: LOCALE_NAMES[l],
        checked: prefs.locale === l,
        onSelect: () => setPrefs({ locale: l }),
      }))}
    />
  );
}

export function ThemeMenu() {
  const { t } = useI18n();
  const { prefs, setPrefs } = usePrefs();
  const Icon = prefs.theme === 'dark' ? MoonIcon : prefs.theme === 'light' ? SunIcon : MonitorIcon;
  return (
    <Menu
      label={t('prefs.theme')}
      trigger={<IconButton label={t('prefs.theme')} icon={<Icon />} data-testid="theme-menu" />}
      items={[
        {
          id: 'system',
          label: t('prefs.themeSystem'),
          icon: <MonitorIcon size={16} />,
          checked: prefs.theme === 'system',
          onSelect: () => setPrefs({ theme: 'system' }),
        },
        {
          id: 'light',
          label: t('prefs.themeLight'),
          icon: <SunIcon size={16} />,
          checked: prefs.theme === 'light',
          onSelect: () => setPrefs({ theme: 'light' }),
        },
        {
          id: 'dark',
          label: t('prefs.themeDark'),
          icon: <MoonIcon size={16} />,
          checked: prefs.theme === 'dark',
          onSelect: () => setPrefs({ theme: 'dark' }),
        },
      ]}
    />
  );
}
