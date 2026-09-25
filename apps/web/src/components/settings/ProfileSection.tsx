'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { ProfileLink, ProfileMode, Profile } from '@yapilapi/api-client';
import {
  Button,
  FormField,
  Input,
  Radio,
  RadioGroup,
  Textarea,
  IconButton,
  TrashIcon,
  PlusIcon,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { describeError } from '@/lib/errors';
import { ErrorView, PageSpinner } from '@/components/common';
import { FormError } from '@/components/forms';
import { SettingsCard } from './shared';

const MODES: ProfileMode[] = ['personal', 'creator', 'professional', 'business'];
const MAX_LINKS = 5;

export function ProfileSection() {
  const api = useApi();
  const { user } = useSession();
  const profile = useAsync(
    (signal) => api.profile.get(user.profile.username, { signal }),
    [api, user.profile.username],
  );
  if (profile.loading && !profile.data) return <PageSpinner />;
  if (profile.error && !profile.data)
    return <ErrorView error={profile.error} onRetry={profile.reload} />;
  if (!profile.data) return null;
  return <ProfileForm profile={profile.data} />;
}

function ProfileForm({ profile }: { profile: Profile }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const { refresh } = useSession();
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [bio, setBio] = useState(profile.bio);
  const [location, setLocation] = useState(profile.locationText ?? '');
  const [mode, setMode] = useState<ProfileMode>(profile.mode);
  const [links, setLinks] = useState<ProfileLink[]>(profile.links);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    setError(null);
  }, [displayName, bio, location, mode, links]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!displayName.trim()) fe['displayName'] = t('signup.displayNameRequired');
    links.forEach((l, i) => {
      if (!l.label.trim()) fe[`link-label-${i}`] = t('profileEdit.linkLabelRequired');
      if (!/^https?:\/\/\S+$/i.test(l.url.trim())) fe[`link-url-${i}`] = t('composer.errLink');
    });
    setFieldErrors(fe);
    if (Object.keys(fe).length) return;
    setBusy(true);
    setError(null);
    try {
      await api.profile.update({
        displayName: displayName.trim(),
        bio: bio.trim(),
        locationText: location.trim() || null,
        mode,
        links: links.map((l) => ({ label: l.label.trim(), url: l.url.trim() })),
      });
      await refresh();
      toast.show({ tone: 'success', title: t('profileEdit.saved') });
    } catch (err) {
      const d = describeError(err, t);
      setError(
        Object.values(d.fields)[0] ? `${d.message} ${Object.values(d.fields)[0]}` : d.message,
      );
    } finally {
      setBusy(false);
    }
  };

  const setLink = (i: number, patch: Partial<ProfileLink>) =>
    setLinks((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="stack">
      <SettingsCard
        id="pf-basic"
        title={t('profileEdit.basics')}
        description={t('profileEdit.basicsHelp')}
      >
        <FormField
          label={t('field.displayName')}
          error={fieldErrors['displayName']}
          required
          requiredLabel={t('common.required')}
        >
          <Input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={60}
            autoComplete="name"
            data-testid="profile-displayname"
          />
        </FormField>
        <FormField label={t('profileEdit.username')} description={t('profileEdit.usernameHelp')}>
          <Input value={profile.username} readOnly dir="ltr" />
        </FormField>
        <FormField
          label={t('profileEdit.bio')}
          description={t('composer.counter', { used: bio.length, max: 300 })}
        >
          <Textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={300}
            rows={4}
            data-testid="profile-bio"
          />
        </FormField>
        <FormField label={t('profileEdit.location')} description={t('profileEdit.locationHelp')}>
          <Input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            maxLength={80}
            autoComplete="off"
          />
        </FormField>
      </SettingsCard>

      <SettingsCard
        id="pf-mode"
        title={t('profileEdit.modeTitle')}
        description={t('profileEdit.modeHelp')}
      >
        <RadioGroup
          legend={t('profileEdit.modeTitle')}
          hideLegend
          value={mode}
          onValueChange={(v) => setMode(v as ProfileMode)}
        >
          {MODES.map((m) => (
            <Radio
              key={m}
              value={m}
              label={t(`mode.${m}`)}
              description={t(`profileEdit.mode.${m}`)}
              card
            />
          ))}
        </RadioGroup>
      </SettingsCard>

      <SettingsCard
        id="pf-links"
        title={t('profile.links')}
        description={t('profileEdit.linksHelp', { max: MAX_LINKS })}
      >
        {links.length === 0 ? <p className="muted">{t('profileEdit.noLinks')}</p> : null}
        <ul className="link-editor">
          {links.map((l, i) => (
            <li key={i} className="link-editor__row">
              <FormField
                label={t('profileEdit.linkLabel', { n: i + 1 })}
                error={fieldErrors[`link-label-${i}`]}
              >
                <Input
                  value={l.label}
                  onChange={(e) => setLink(i, { label: e.target.value })}
                  maxLength={40}
                />
              </FormField>
              <FormField
                label={t('profileEdit.linkUrl', { n: i + 1 })}
                error={fieldErrors[`link-url-${i}`]}
              >
                <Input
                  value={l.url}
                  onChange={(e) => setLink(i, { url: e.target.value })}
                  inputMode="url"
                  dir="ltr"
                  maxLength={300}
                  placeholder="https://"
                />
              </FormField>
              <IconButton
                label={t('profileEdit.removeLink', { n: i + 1 })}
                icon={<TrashIcon size={18} />}
                onClick={() => setLinks((ls) => ls.filter((_, j) => j !== i))}
              />
            </li>
          ))}
        </ul>
        {links.length < MAX_LINKS ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setLinks((ls) => [...ls, { label: '', url: '' }])}
          >
            <PlusIcon size={16} /> {t('profileEdit.addLink')}
          </Button>
        ) : null}
      </SettingsCard>

      <FormError>{error}</FormError>
      <div className="button-row">
        <Button
          type="submit"
          loading={busy}
          loadingLabel={t('common.saving')}
          data-testid="profile-save"
        >
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}
