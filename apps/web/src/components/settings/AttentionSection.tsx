'use client';

import { useState, type FormEvent } from 'react';
import { Button, FormField, Input, Switch } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { usePreferences } from '@/lib/preferences';
import { minutesToTime, timeToMinutes } from '@/lib/attention';
import { FormError } from '@/components/forms';
import { SettingsCard, useSavePrefs } from './shared';

export function AttentionSection() {
  const { t } = useI18n();
  const { saved } = usePreferences();
  const save = useSavePrefs();
  const [limitOn, setLimitOn] = useState(saved?.dailyLimitMinutes != null);
  const [limit, setLimit] = useState(String(saved?.dailyLimitMinutes ?? 60));
  const [quietOn, setQuietOn] = useState(
    saved?.quietHoursStart != null && saved?.quietHoursEnd != null,
  );
  const [start, setStart] = useState(minutesToTime(saved?.quietHoursStart ?? 22 * 60));
  const [end, setEnd] = useState(minutesToTime(saved?.quietHoursEnd ?? 7 * 60));
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ limit?: string; quiet?: string }>({});
  if (!saved) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs: { limit?: string; quiet?: string } = {};
    const n = Number(limit);
    if (limitOn && (!Number.isInteger(n) || n < 5 || n > 1440))
      errs.limit = t('attentionSettings.limitInvalid');
    const s = timeToMinutes(start);
    const en = timeToMinutes(end);
    if (quietOn && (s === null || en === null || s === en))
      errs.quiet = t('attentionSettings.quietInvalid');
    setErrors(errs);
    if (errs.limit || errs.quiet) return;
    setBusy(true);
    await save({
      dailyLimitMinutes: limitOn ? n : null,
      quietHoursStart: quietOn ? s : null,
      quietHoursEnd: quietOn ? en : null,
    });
    setBusy(false);
  };

  return (
    <div className="stack">
      <SettingsCard id="at-focus" title={t('attentionSettings.focusTitle')}>
        <Switch
          label={t('attentionSettings.focus')}
          description={t('attentionSettings.focusHelp')}
          checked={saved.focusMode}
          onChange={(e) => void save({ focusMode: e.target.checked })}
          data-testid="focus-mode"
        />
      </SettingsCard>
      <form onSubmit={(e) => void submit(e)} noValidate className="stack">
        <SettingsCard
          id="at-limit"
          title={t('attentionSettings.limitTitle')}
          description={t('attentionSettings.limitHelp')}
        >
          <Switch
            label={t('attentionSettings.limitToggle')}
            checked={limitOn}
            onChange={(e) => setLimitOn(e.target.checked)}
          />
          {limitOn ? (
            <FormField
              label={t('attentionSettings.limitMinutes')}
              description={t('attentionSettings.limitRange')}
              error={errors.limit}
            >
              <Input
                type="number"
                inputMode="numeric"
                min={5}
                max={1440}
                step={5}
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                data-testid="daily-limit"
              />
            </FormField>
          ) : null}
        </SettingsCard>
        <SettingsCard
          id="at-quiet"
          title={t('attentionSettings.quietTitle')}
          description={t('attentionSettings.quietHelp')}
        >
          <Switch
            label={t('attentionSettings.quietToggle')}
            checked={quietOn}
            onChange={(e) => setQuietOn(e.target.checked)}
          />
          {quietOn ? (
            <div className="inline-form">
              <FormField label={t('attentionSettings.quietFrom')}>
                <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
              </FormField>
              <FormField label={t('attentionSettings.quietTo')}>
                <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
              </FormField>
            </div>
          ) : null}
          <FormError>{errors.quiet}</FormError>
        </SettingsCard>
        <div className="button-row">
          <Button
            type="submit"
            loading={busy}
            loadingLabel={t('common.saving')}
            data-testid="attention-save"
          >
            {t('common.save')}
          </Button>
        </div>
      </form>
    </div>
  );
}
