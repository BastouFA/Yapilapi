'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert, Avatar, Button, Card, Select, TextField } from '@yapilapi/design-system';
import { IMAGE_ACCEPT, PROFILE_MODES, type AccountInfo, type MessageKey, type Profile } from '@yapilapi/shared';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { PasswordField } from '@/components/PasswordField';
import { useSession } from '@/app/providers';
import { Anchor, SettingsLink } from './Shell';

/** Your photo, name, bio and profile type: how people see you. */
export function ProfileCard() {
  const { me, refresh, toast, t } = useSession();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  useEffect(() => {
    if (me) api.users.get(me.username).then((r) => setProfile(r.profile));
  }, [me]);
  if (!profile || !me) return null;
  return (
    <Anchor id="profile">
      <Card title={t('settings.tab.profile')} subtitle={t('st.profile.desc')}>
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            setBusy(true);
            setFields({});
            try {
              await api.me.updateProfile({ displayName: String(f.get('displayName')), bio: String(f.get('bio') ?? ''), mode: String(f.get('mode')) });
              await refresh();
              toast(t('settings.profileSaved'));
            } catch (err) {
              toast(errorMessage(err));
              setFields(fieldErrors(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="row" style={{ gap: 16 }}>
            <Avatar name={me.displayName} src={profile.avatarUrl} size="lg" />
            <label className="yp-btn yp-btn--secondary yp-btn--sm" style={{ cursor: 'pointer' }}>
              {uploading ? t('settings.uploading') : t('settings.changePhoto')}
              <input
                type="file"
                accept={IMAGE_ACCEPT}
                hidden
                onChange={async (e) => {
                  const file = e.currentTarget.files?.[0];
                  if (!file) return;
                  setUploading(true);
                  try {
                    const { media } = await api.media.upload(file);
                    const url = new URL(media.url, location.origin).toString();
                    await api.me.updateProfile({ avatarUrl: url });
                    setProfile((p) => (p ? { ...p, avatarUrl: url } : p));
                    await refresh();
                  } catch (err) {
                    toast(errorMessage(err));
                  } finally {
                    setUploading(false);
                  }
                }}
              />
            </label>
          </div>
          <TextField label={t('auth.displayName')} name="displayName" defaultValue={profile.displayName} maxLength={60} error={fields.displayName} />
          <TextField label={t('settings.bio')} name="bio" multiline defaultValue={profile.bio} maxLength={300} error={fields.bio} />
          <Select label={t('settings.profileType')} name="mode" defaultValue={profile.mode}>
            {PROFILE_MODES.map((m) => (
              <option key={m} value={m}>
                {t(`settings.mode.${m}` as MessageKey)}
              </option>
            ))}
          </Select>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <Button type="submit" loading={busy}>
              {t('settings.saveProfile')}
            </Button>
            <Link href={`/u/${me.username}`} className="muted">
              {t('st.profile.more')}
            </Link>
          </div>
        </form>
      </Card>
    </Anchor>
  );
}

/** Username, date of birth and when you joined, read-only. */
export function SignInDetailsCard() {
  const { me, t, locale } = useSession();
  const [account, setAccount] = useState<AccountInfo | null>(null);
  useEffect(() => {
    api.me.account().then(
      (r) => setAccount(r.account),
      () => {},
    );
  }, []);
  if (!me) return null;
  const long = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' });
  return (
    <Anchor id="sign-in">
      <Card title={t('st.signin.title')} subtitle={t('st.signin.desc')}>
        <dl className="settings-facts">
          <div>
            <dt>{t('auth.username')}</dt>
            <dd>
              @{me.username}
              <span className="muted settings-facts__hint">{t('st.username.hint')}</span>
            </dd>
          </div>
          <div>
            <dt>{t('auth.birthDate')}</dt>
            <dd>
              {account ? (account.birthDate ? long.format(new Date(`${account.birthDate}T00:00:00Z`)) : t('st.birthDate.none')) : '…'}
              <span className="muted settings-facts__hint">{t('st.birthDate.hint')}</span>
            </dd>
          </div>
          {account ? (
            <div>
              <dt>{t('st.memberSince')}</dt>
              <dd>{long.format(new Date(account.createdAt))}</dd>
            </div>
          ) : null}
        </dl>
        <div className="settings-group__rows" style={{ marginTop: 12 }}>
          <SettingsLink href="/settings/security#password" icon="key" title={t('st.password.title')} desc={t('st.password.desc')} />
        </div>
      </Card>
    </Anchor>
  );
}

/** Change your password; other devices are signed out, this one stays signed in. */
export function ChangePasswordCard() {
  const { t, toast } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const mismatch = !!again && next !== again;
  return (
    <Anchor id="password">
      <Card title={t('st.password.title')} subtitle={t('st.password.desc')}>
        <form
          className="stack-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            if (next !== again) return setErr(t('st.password.mismatch'));
            setBusy(true);
            setErr(null);
            setFields({});
            try {
              await api.auth.changePassword(current, next);
              setCurrent('');
              setNext('');
              setAgain('');
              toast(t('st.password.changed'));
            } catch (e2) {
              setErr(errorMessage(e2));
              setFields(fieldErrors(e2));
            } finally {
              setBusy(false);
            }
          }}
        >
          {err ? <Alert tone="danger">{err}</Alert> : null}
          <PasswordField
            label={t('st.password.current')}
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.currentTarget.value)}
            error={fields.currentPassword}
            required
          />
          <PasswordField
            label={t('st.password.new')}
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.currentTarget.value)}
            hint={t('auth.password.hint')}
            error={fields.newPassword}
            minLength={10}
            required
          />
          <PasswordField
            label={t('st.password.confirm')}
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.currentTarget.value)}
            error={mismatch ? t('st.password.mismatch') : undefined}
            required
          />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <Button type="submit" loading={busy} disabled={!current || next.length < 10 || next !== again}>
              {t('st.password.change')}
            </Button>
            <Link href="/forgot-password" className="muted">
              {t('auth.forgot')}
            </Link>
          </div>
        </form>
      </Card>
    </Anchor>
  );
}
