'use client';

import { useMemo } from 'react';
import type { Preferences } from '@yapilapi/api-client';
import { FormField, Radio, RadioGroup, Select, Switch } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { LOCALES, LOCALE_NAMES, type Locale } from '@/i18n/core';
import { usePreferences } from '@/lib/preferences';
import { usePrefs } from '@/lib/prefs';
import { SettingsCard, useSavePrefs } from './shared';

const CURRENCIES = [
  'USD',
  'EUR',
  'GBP',
  'NGN',
  'GHS',
  'KES',
  'ZAR',
  'XOF',
  'XAF',
  'EGP',
  'MAD',
  'AED',
  'SAR',
  'INR',
  'BRL',
  'CAD',
  'AUD',
  'JPY',
  'CNY',
];
const THEMES: Array<Preferences['theme']> = ['system', 'light', 'dark'];

function timeZones(current: string): string[] {
  const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  let list: string[] = [];
  try {
    list = fn ? fn('timeZone') : [];
  } catch {
    list = [];
  }
  if (!list.includes('UTC')) list = ['UTC', ...list];
  if (current && !list.includes(current)) list = [current, ...list];
  return list;
}

export function DisplaySection() {
  const { t } = useI18n();
  const { saved } = usePreferences();
  const { prefs, setPrefs } = usePrefs();
  const save = useSavePrefs();
  const zones = useMemo(() => timeZones(saved?.timezone ?? 'UTC'), [saved?.timezone]);
  if (!saved) return null;
  const currencies = CURRENCIES.includes(saved.currency)
    ? CURRENCIES
    : [saved.currency, ...CURRENCIES];

  return (
    <div className="stack">
      <SettingsCard
        id="ds-lang"
        title={t('display.languageTitle')}
        description={t('display.languageHelp')}
      >
        <FormField label={t('prefs.language')}>
          <Select
            value={prefs.locale}
            onChange={(e) => void save({ locale: e.target.value as Locale })}
            data-testid="display-language"
          >
            {LOCALES.map((l) => (
              <option key={l} value={l} lang={l}>
                {LOCALE_NAMES[l]}
              </option>
            ))}
          </Select>
        </FormField>
        <p className="muted">{t('display.reviewNote')}</p>
      </SettingsCard>

      <SettingsCard id="ds-theme" title={t('prefs.theme')}>
        <RadioGroup
          legend={t('prefs.theme')}
          hideLegend
          value={saved.theme}
          onValueChange={(v) => void save({ theme: v as Preferences['theme'] })}
        >
          {THEMES.map((th) => (
            <Radio
              key={th}
              value={th}
              label={t(
                th === 'system'
                  ? 'prefs.themeSystem'
                  : th === 'light'
                    ? 'prefs.themeLight'
                    : 'prefs.themeDark',
              )}
            />
          ))}
        </RadioGroup>
      </SettingsCard>

      <SettingsCard
        id="ds-access"
        title={t('display.accessTitle')}
        description={t('display.accessHelp')}
      >
        <Switch
          label={t('display.reducedMotion')}
          description={t('display.reducedMotionHelp')}
          checked={saved.reducedMotion}
          onChange={(e) => void save({ reducedMotion: e.target.checked })}
          data-testid="reduced-motion"
        />
        <Switch
          label={t('display.lowBandwidth')}
          description={t('display.lowBandwidthHelp')}
          checked={saved.lowBandwidth}
          onChange={(e) => void save({ lowBandwidth: e.target.checked })}
          data-testid="low-bandwidth"
        />
        <Switch
          label={t('display.contrast')}
          description={t('display.contrastHelp')}
          checked={prefs.contrast === 'more'}
          onChange={(e) => setPrefs({ contrast: e.target.checked ? 'more' : 'normal' })}
          data-testid="high-contrast"
        />
      </SettingsCard>

      <SettingsCard id="ds-region" title={t('display.regionTitle')}>
        <FormField label={t('display.timezone')} description={t('display.timezoneHelp')}>
          <Select value={saved.timezone} onChange={(e) => void save({ timezone: e.target.value })}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label={t('display.currency')} description={t('display.currencyHelp')}>
          <Select value={saved.currency} onChange={(e) => void save({ currency: e.target.value })}>
            {currencies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </FormField>
      </SettingsCard>
    </div>
  );
}
