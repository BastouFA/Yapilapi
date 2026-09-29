'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Avatar, BottomSheet, Button, Card, Select, TextField } from '@yapilapi/design-system';
import {
  IMAGE_ACCEPT,
  PROFILE_MODES,
  usernameProblem,
  type AccountInfo,
  type MessageKey,
  type Profile,
  type UsernameCheck,
  type UsernameStatus,
} from '@yapilapi/shared';
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!me) return;
    setLoadError(null);
    api.users.get(me.username).then(
      (r) => setProfile(r.profile),
      (e) => setLoadError(errorMessage(e)),
    );
  }, [me]);
  useEffect(load, [load]);
  if (!me) return null;
  if (!profile)
    return loadError ? (
      <Card title={t('settings.tab.profile')}>
        <Alert tone="danger">{loadError}</Alert>
        <Button variant="secondary" onClick={load}>
          {t('m.common.retry')}
        </Button>
      </Card>
    ) : null;
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
                    // The server keeps the photo's own processed size.
                    const r = await api.me.updateProfile({ avatarUrl: url });
                    setProfile(r.profile);
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

/** Username (with Change username), date of birth and when you joined. */
export function SignInDetailsCard() {
  const { me, t, locale } = useSession();
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [status, setStatus] = useState<UsernameStatus | null>(null);
  const [changing, setChanging] = useState(false);
  useEffect(() => {
    api.me.account().then(
      (r) => setAccount(r.account),
      () => {},
    );
    api.me.username().then(
      (r) => setStatus(r.status),
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
              <span className="muted settings-facts__hint">
                {status?.nextChangeAt ? t('st.username.next', { date: long.format(new Date(status.nextChangeAt)) }) : t('st.username.hint')}
              </span>
              <Button size="sm" variant="secondary" style={{ marginTop: 8 }} disabled={!status || !!status.nextChangeAt} onClick={() => setChanging(true)}>
                {t('st.username.change')}
              </Button>
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
      <ChangeUsernameSheet open={changing} onClose={() => setChanging(false)} onChanged={setStatus} />
    </Anchor>
  );
}

const CHECK_TEXT: Record<NonNullable<UsernameCheck['reason']>, MessageKey> = {
  taken: 'st.username.taken',
  held: 'st.username.taken',
  reserved: 'st.username.reserved',
  invalid: 'st.username.invalid',
  current: 'st.username.current',
};

/** Whether a new username can be used, checked as you type (after a short pause). */
function useUsernameCheck(value: string) {
  const [state, setState] = useState<{ name: string; ok: boolean | null; reason?: UsernameCheck['reason'] }>({ name: '', ok: null });
  const latest = useRef('');
  useEffect(() => {
    const name = value.trim();
    latest.current = name;
    if (!name) return setState({ name, ok: null });
    // The rules are known here: no need to ask the server about a name that breaks them.
    const problem = usernameProblem(name);
    if (problem) return setState({ name, ok: false, reason: problem === 'reserved' ? 'reserved' : 'invalid' });
    setState({ name, ok: null });
    const timer = setTimeout(() => {
      api.auth.checkUsername(name, 'change').then(
        (r) => latest.current === name && setState({ name, ok: r.available, reason: r.reason }),
        () => latest.current === name && setState({ name, ok: null }),
      );
    }, 350);
    return () => clearTimeout(timer);
  }, [value]);
  return state;
}

/** Change your username: checked as you type, then confirmed, since it can't change again for 14 days. */
function ChangeUsernameSheet({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: (s: UsernameStatus) => void }) {
  const { t, toast, setMe } = useSession();
  const [value, setValue] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = useUsernameCheck(value);
  useEffect(() => {
    if (!open) return;
    setValue('');
    setConfirming(false);
    setError(null);
  }, [open]);
  const name = value.trim();
  const checking = !!name && check.name === name && check.ok === null;
  const message = !name
    ? t('st.username.rule')
    : check.name !== name || check.ok === null
      ? t('st.username.checking')
      : check.ok
        ? t('st.username.available', { name })
        : t(CHECK_TEXT[check.reason ?? 'taken']);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.me.changeUsername(name);
      setMe(r.user);
      onChanged(r.status);
      toast(t('st.username.saved', { name: r.user.username }));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={t('st.username.changeTitle')}>
      <form
        className="stack"
        style={{ gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (check.ok && check.name === name) setConfirming(true);
        }}
      >
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          {t('st.username.changeDesc')}
        </p>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <TextField
          label={t('st.username.new')}
          value={value}
          onChange={(e) => {
            setValue(e.currentTarget.value.replace(/^@/, ''));
            setConfirming(false);
          }}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={30}
          hint={check.ok === false ? undefined : message}
          error={check.ok === false && check.name === name ? message : undefined}
          aria-busy={checking || undefined}
        />
        <span className="yp-visually-hidden" role="status" aria-live="polite">
          {name && check.name === name && check.ok !== null ? message : ''}
        </span>
        {confirming ? <Alert tone="warning">{t('st.username.confirm', { name })}</Alert> : null}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {confirming ? (
            <Button loading={busy} onClick={() => void save()}>
              {t('st.username.save')}
            </Button>
          ) : (
            <Button type="submit" disabled={!(check.ok && check.name === name)}>
              {t('st.username.change')}
            </Button>
          )}
        </div>
      </form>
    </BottomSheet>
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
