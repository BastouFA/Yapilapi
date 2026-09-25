'use client';

import { useState } from 'react';
import type { Preferences } from '@yapilapi/api-client';
import { FormField, Radio, RadioGroup, Select, Switch, useToast } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { usePreferences } from '@/lib/preferences';
import { describeError } from '@/lib/errors';
import { SettingsCard, useSavePrefs } from './shared';

const VIS: Array<Preferences['defaultPostVisibility']> = [
  'public',
  'followers',
  'friends',
  'private',
];
const WHO: Array<Preferences['whoCanMessage']> = ['everyone', 'followers', 'friends', 'nobody'];
const SENSITIVE: Array<Preferences['sensitiveContent']> = ['hide', 'limit', 'allow'];

export function PrivacySection() {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const { user, isTeen } = useSession();
  const { saved } = usePreferences();
  const save = useSavePrefs();
  const profile = useAsync(
    (signal) => api.profile.get(user.profile.username, { signal }),
    [api, user.profile.username],
  );
  const [priv, setPriv] = useState<boolean | null>(null);
  if (!saved) return null;
  const isPrivate = isTeen ? true : (priv ?? profile.data?.isPrivate ?? false);

  const setPrivate = async (next: boolean) => {
    setPriv(next);
    try {
      await api.profile.update({ isPrivate: next });
      toast.show({ tone: 'success', title: t('common.saved') });
    } catch (e) {
      setPriv(!next);
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    }
  };

  return (
    <div className="stack">
      <SettingsCard
        id="pv-account"
        title={t('privacy.accountTitle')}
        description={t('privacy.accountHelp')}
      >
        <Switch
          label={t('privacy.private')}
          description={isTeen ? t('privacy.privateTeen') : t('privacy.privateHelp')}
          checked={isPrivate}
          disabled={isTeen || profile.loading}
          onChange={(e) => void setPrivate(e.target.checked)}
          data-testid="privacy-private"
        />
        <Switch
          label={t('privacy.discoverable')}
          description={t('privacy.discoverableHelp')}
          checked={saved.discoverable}
          onChange={(e) => void save({ discoverable: e.target.checked })}
        />
      </SettingsCard>

      <SettingsCard id="pv-posts" title={t('privacy.postsTitle')}>
        <RadioGroup
          legend={t('privacy.defaultVisibility')}
          description={t('privacy.defaultVisibilityHelp')}
          value={saved.defaultPostVisibility}
          onValueChange={(v) =>
            void save({ defaultPostVisibility: v as Preferences['defaultPostVisibility'] })
          }
        >
          {VIS.map((v) => (
            <Radio
              key={v}
              value={v}
              label={t(`visibility.${v}`)}
              description={
                v === 'public' && isTeen ? t('composer.teenPublicBlocked') : t(`audience.${v}`)
              }
              disabled={isTeen && v === 'public'}
              card
            />
          ))}
        </RadioGroup>
      </SettingsCard>

      <SettingsCard id="pv-people" title={t('privacy.peopleTitle')}>
        <FormField label={t('privacy.whoCanMessage')} description={t('privacy.whoCanMessageHelp')}>
          <Select
            value={saved.whoCanMessage}
            onChange={(e) =>
              void save({ whoCanMessage: e.target.value as Preferences['whoCanMessage'] })
            }
          >
            {WHO.map((w) => (
              <option key={w} value={w}>
                {t(`privacy.who.${w}`)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label={t('privacy.sensitive')} description={t('privacy.sensitiveHelp')}>
          <Select
            value={saved.sensitiveContent}
            onChange={(e) =>
              void save({ sensitiveContent: e.target.value as Preferences['sensitiveContent'] })
            }
          >
            {SENSITIVE.map((s) => (
              <option key={s} value={s}>
                {t(`privacy.sensitive.${s}`)}
              </option>
            ))}
          </Select>
        </FormField>
      </SettingsCard>

      <SettingsCard id="pv-feed" title={t('privacy.feedTitle')}>
        <Switch
          label={t('privacy.personalization')}
          description={t('privacy.personalizationHelp')}
          checked={saved.personalization}
          onChange={(e) => void save({ personalization: e.target.checked })}
        />
      </SettingsCard>
    </div>
  );
}
