'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Dialog, List, ListItem, Select, Switch, Tabs, TextField } from '@yapilapi/design-system';
import { NOTIFICATION_CATEGORIES, PROFILE_MODES, SUPPORTED_LOCALES, formatRelativeTime } from '@yapilapi/shared';
import { startRegistration } from '@simplewebauthn/browser';
import type { SharingSettings as SharingSettingsState } from '@yapilapi/api-client';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { currentSubscription, disableBrowserPush, enableBrowserPush, pushSupported } from '@/lib/push';
import { FamilyCard } from '@/components/Family';
import { useSession } from '../../providers';

export default function Settings() {
  const [tab, setTab] = useState(() => (typeof location !== 'undefined' && location.hash === '#moderation' ? 'safety' : 'profile'));
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>Settings</h1>
      </div>
      <Tabs
        id="settings-tabs"
        panelId="settings-panel"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'profile', label: 'Profile' },
          { id: 'attention', label: 'Attention' },
          { id: 'privacy', label: 'Privacy' },
          { id: 'security', label: 'Security' },
          { id: 'safety', label: 'Safety' },
        ]}
      />
      <div role="tabpanel" id="settings-panel" aria-labelledby={`settings-tabs-${tab}`}>
        {tab === 'profile' ? (
          <div className="stack">
            <PlusAndInvites />
            <ProfileSettings />
          </div>
        ) : tab === 'attention' ? (
          <AttentionSettings />
        ) : tab === 'privacy' ? (
          <PrivacyCenter />
        ) : tab === 'security' ? (
          <SecuritySettings />
        ) : (
          <SafetySettings />
        )}
      </div>
    </div>
  );
}

/** YAPILAPI Plus status and the invite link, each with its own page. */
function PlusAndInvites() {
  const { me, t, locale } = useSession();
  const until = me?.plusUntil ? new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(me.plusUntil)) : null;
  return (
    <div className="settings-duo">
      <Card level={2} title={t('plus.title')} subtitle={until ? t('plus.status.active', { date: until }) : t('plus.status.none')}>
        <Link href="/plus" className="yp-btn yp-btn--secondary yp-btn--sm">
          {t('plus.open')}
        </Link>
      </Card>
      <Card level={2} title={t('invite.title')} subtitle={t('plus.inviteHint')}>
        <Link href="/invite" className="yp-btn yp-btn--secondary yp-btn--sm">
          {t('invite.title')}
        </Link>
      </Card>
    </div>
  );
}

function ProfileSettings() {
  const { me, refresh, toast, locale } = useSession();
  const [profile, setProfile] = useState<Record<string, any> | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  useEffect(() => {
    if (me) api.users.get(me.username).then((r) => setProfile(r.profile));
  }, [me]);
  if (!profile) return null;
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setBusy(true);
        setFields({});
        try {
          await api.me.updateProfile({
            displayName: String(f.get('displayName')),
            bio: String(f.get('bio') ?? ''),
            mode: String(f.get('mode')),
            locale: String(f.get('locale')),
            // Only when changed: saving other fields mustn't turn a detected country into a chosen one.
            ...((f.get('country') ? String(f.get('country')) : null) !== (me?.country ?? null)
              ? { country: f.get('country') ? String(f.get('country')) : null }
              : {}),
            isPrivate: f.get('isPrivate') === 'on',
            avatarUrl: profile.avatarUrl ?? null,
          });
          await refresh();
          toast('Profile saved');
        } catch (err) {
          toast(errorMessage(err));
          setFields(fieldErrors(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="row">
        <label className="yp-btn yp-btn--secondary yp-btn--sm" style={{ cursor: 'pointer' }}>
          {uploading ? 'Uploading…' : 'Change photo'}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            hidden
            onChange={async (e) => {
              const file = e.currentTarget.files?.[0];
              if (!file) return;
              setUploading(true);
              try {
                const { media } = await api.media.upload(file);
                const url = new URL(media.url, location.origin).toString();
                await api.me.updateProfile({ avatarUrl: url });
                setProfile((p) => ({ ...p!, avatarUrl: url }));
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
      <TextField label="Name" name="displayName" defaultValue={profile.displayName} maxLength={60} error={fields.displayName} />
      <TextField label="Bio" name="bio" multiline defaultValue={profile.bio} maxLength={300} error={fields.bio} />
      <Select label="Profile type" name="mode" defaultValue={profile.mode}>
        {PROFILE_MODES.map((m) => (
          <option key={m} value={m}>
            {m[0]!.toUpperCase() + m.slice(1)}
          </option>
        ))}
      </Select>
      <Select label="Language" name="locale" defaultValue={me?.locale ?? 'en'}>
        {SUPPORTED_LOCALES.map((l) => (
          <option key={l} value={l}>
            {new Intl.DisplayNames([l], { type: 'language' }).of(l)}
          </option>
        ))}
      </Select>
      <Select label="Country" name="country" defaultValue={me?.country ?? ''} hint="Some content can be unavailable in some countries for legal reasons.">
        <option value="">Not set</option>
        {countries(locale).map(([code, name]) => (
          <option key={code} value={code}>
            {name}
          </option>
        ))}
      </Select>
      <label className="yp-check">
        <input type="checkbox" name="isPrivate" defaultChecked={profile.isPrivate} />
        <span>
          Private account
          <span className="yp-check__desc">Only approved followers see your posts.</span>
        </span>
      </label>
      <Button type="submit" loading={busy}>
        Save profile
      </Button>
    </form>
  );
}

function AttentionSettings() {
  const { toast } = useSession();
  const [prefs, setPrefs] = useState<{ notifications: Record<string, boolean>; attention: Record<string, any> } | null>(null);
  useEffect(() => {
    api.me.preferences().then(setPrefs);
  }, []);
  if (!prefs) return null;
  const setA = async (k: string, v: unknown) => {
    setPrefs((p) => ({ ...p!, attention: { ...p!.attention, [k]: v } }));
    try {
      await api.me.setAttention({ [k]: v });
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  const a = prefs.attention;
  return (
    <div className="stack">
      <Card title="Your feed, your rules" subtitle="YAPILAPI doesn't optimize for time spent. These controls apply immediately.">
        <div className="stack">
          <Switch label="Friends only (For You shows only friends)" checked={!!a.friendsOnly} onChange={(v) => setA('friendsOnly', v)} />
          <Switch
            label="Reduced recommendations (only people and communities you chose)"
            checked={!!a.reducedRecommendations}
            onChange={(v) => setA('reducedRecommendations', v)}
          />
          <Switch label="Focus mode (hide counts and non-essential badges)" checked={!!a.focusMode} onChange={(v) => setA('focusMode', v)} />
          <Switch label="Quiet mode (no sounds or vibrations)" checked={!!a.quietMode} onChange={(v) => setA('quietMode', v)} />
          <Select
            label="Daily time budget"
            value={String(a.dailyTimeBudgetMinutes ?? '')}
            onChange={(e) => setA('dailyTimeBudgetMinutes', e.currentTarget.value ? Number(e.currentTarget.value) : null)}
          >
            <option value="">No limit</option>
            {[15, 30, 45, 60, 90, 120].map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </Select>
          <div className="row">
            <Button size="sm" variant="secondary" onClick={() => setA('notificationsPausedUntil', new Date(Date.now() + 8 * 3600_000).toISOString())}>
              Pause notifications for 8 hours
            </Button>
            {a.notificationsPausedUntil && new Date(a.notificationsPausedUntil) > new Date() ? (
              <Button size="sm" variant="ghost" onClick={() => setA('notificationsPausedUntil', null)}>
                Resume now
              </Button>
            ) : null}
          </div>
        </div>
      </Card>
      <Card title="Notifications" subtitle="Security notifications are always on.">
        <div className="stack-sm">
          {NOTIFICATION_CATEGORIES.map((c) => (
            <Switch
              key={c}
              label={c[0]!.toUpperCase() + c.slice(1)}
              checked={prefs.notifications[c] !== false}
              disabled={c === 'security'}
              onChange={async (v) => {
                setPrefs((p) => ({ ...p!, notifications: { ...p!.notifications, [c]: v } }));
                await api.me.setNotificationPrefs({ [c]: v }).catch((e) => toast(errorMessage(e)));
              }}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

const PURPOSES: Record<string, string> = {
  personalization: 'Personalize my feed and suggestions',
  ai_processing: 'Let the assistant remember things I tell it',
  advertising: 'Show me sponsored posts based on my interests (adults only)',
  analytics: 'Help improve YAPILAPI with usage analytics',
};

/** Who can find you from their contacts, and whether others can save your reels as a video. */
function SharingSettings() {
  const { toast, t } = useSession();
  const [settings, setSettings] = useState<SharingSettingsState | null>(null);
  useEffect(() => {
    api.me.sharing().then(
      (r) => setSettings(r.settings),
      () => {},
    );
  }, []);
  if (!settings) return null;
  const set = async (k: 'findableByContacts' | 'allowDownload', v: boolean) => {
    const before = settings;
    setSettings({ ...settings, [k]: v });
    try {
      setSettings((await api.me.setSharing({ [k]: v })).settings);
    } catch (e) {
      setSettings(before);
      toast(errorMessage(e));
    }
  };
  return (
    <Card title={t('sharing.title')} subtitle={settings.locked ? t('sharing.locked') : undefined}>
      <div className="stack">
        <div className="stack-sm">
          <Switch
            label={t('sharing.findable')}
            checked={settings.findableByContacts}
            disabled={settings.locked}
            onChange={(v) => set('findableByContacts', v)}
          />
          <p className="muted setting-hint">{t('sharing.findable.hint')}</p>
        </div>
        <div className="stack-sm">
          <Switch label={t('sharing.allowDownload')} checked={settings.allowDownload} disabled={settings.locked} onChange={(v) => set('allowDownload', v)} />
          <p className="muted setting-hint">{t('sharing.allowDownload.hint')}</p>
        </div>
      </div>
    </Card>
  );
}

function PrivacyCenter() {
  const { toast, setMe } = useSession();
  const router = useRouter();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.me.privacy>> | null>(null);
  const [memories, setMemories] = useState<{ id: string; content: string }[]>([]);
  const [memory, setMemory] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const reload = () => api.me.privacy().then(setData);
  useEffect(() => {
    void reload();
    api.ai
      .memories()
      .then((r) => setMemories(r.items))
      .catch(() => {});
  }, []);
  if (!data) return null;
  const granted = (p: string) => !!data.consents.find((c) => c.purpose === p)?.granted;

  return (
    <div className="stack">
      <SharingSettings />
      <Card title="What we hold about you">
        <div className="stats">
          {Object.entries(data.dataSummary).map(([k, v]) => (
            <div key={k} className="yp-stat">
              <span className="yp-stat__label">{k.replace(/_/g, ' ')}</span>
              <span className="yp-stat__value">{v}</span>
            </div>
          ))}
        </div>
      </Card>
      <Card title="How your data is used">
        <div className="stack-sm">
          {Object.entries(PURPOSES).map(([p, label]) => (
            <Switch
              key={p}
              label={label}
              checked={granted(p)}
              onChange={async (v) => {
                await api.me.setConsent(p, v).catch((e) => toast(errorMessage(e)));
                await reload();
              }}
            />
          ))}
        </div>
      </Card>
      <Card title="Assistant memory" subtitle="Nothing is added automatically. You can delete any item.">
        <div className="stack-sm">
          {memories.length ? (
            <List>
              {memories.map((m) => (
                <ListItem
                  key={m.id}
                  primary={<span style={{ whiteSpace: 'normal', fontWeight: 400 }}>{m.content}</span>}
                  end={
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        await api.ai.deleteMemory(m.id);
                        setMemories((x) => x.filter((y) => y.id !== m.id));
                      }}
                    >
                      Delete
                    </Button>
                  }
                />
              ))}
            </List>
          ) : (
            <p className="muted">The assistant doesn't remember anything about you.</p>
          )}
          <form
            className="row"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api.ai.addMemory(memory);
                setMemory('');
                setMemories((await api.ai.memories()).items);
              } catch (e2) {
                toast(errorMessage(e2));
              }
            }}
          >
            <TextField
              label="Add something to remember"
              value={memory}
              onChange={(e) => setMemory(e.currentTarget.value)}
              maxLength={1000}
              style={{ flex: 1 }}
            />
            <Button type="submit" size="sm" disabled={!memory.trim()}>
              Add
            </Button>
          </form>
        </div>
      </Card>
      <ConnectedApps />
      <Card title="Your data">
        <div className="row">
          <Button
            variant="secondary"
            icon="database"
            onClick={async () => {
              try {
                const blob = new Blob([JSON.stringify(await api.me.exportData(), null, 2)], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'yapilapi-data.json';
                a.click();
                URL.revokeObjectURL(a.href);
              } catch (e) {
                toast(errorMessage(e));
              }
            }}
          >
            Download my data
          </Button>
          <Button variant="danger" icon="trash" onClick={() => setDeleting(true)}>
            Delete my account
          </Button>
        </div>
      </Card>
      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title="Delete your account?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!password}
              onClick={async () => {
                try {
                  await api.me.deleteAccount(password);
                  setMe(null);
                  router.replace('/');
                } catch (e) {
                  setErr(errorMessage(e));
                }
              }}
            >
              Delete account
            </Button>
          </>
        }
      >
        <div className="stack-sm">
          <p style={{ margin: 0 }}>
            Your posts, messages, connections and assistant memory are removed and you're signed out everywhere. This can't be undone.
          </p>
          {err ? <Alert tone="danger">{err}</Alert> : null}
          <TextField
            label="Enter your password to confirm"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
        </div>
      </Dialog>
    </div>
  );
}

function SecuritySettings() {
  const { toast, setMe, locale } = useSession();
  const router = useRouter();
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof api.auth.sessions>>['items']>([]);
  const load = () => api.auth.sessions().then((r) => setSessions(r.items));
  useEffect(() => {
    void load();
  }, []);
  return (
    <div className="stack">
      <Card title="Where you're signed in">
        <List>
          {sessions.map((s) => (
            <ListItem
              key={s.id}
              primary={`${s.device}${s.current ? ' (this device)' : ''}`}
              secondary={`${s.ip ?? 'Unknown IP'} · active ${formatRelativeTime(s.last_seen_at, locale)}`}
              end={
                s.current ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await api.auth.revokeSession(s.id).catch((e) => toast(errorMessage(e)));
                      await load();
                    }}
                  >
                    Sign out
                  </Button>
                )
              }
            />
          ))}
        </List>
      </Card>
      <TwoStepCard />
      <PasskeysCard />
      <BrowserPushCard />
      <FamilyCard />
      <Card title="Developers" subtitle="Build integrations with API keys and webhooks.">
        <a href="/developers" className="yp-btn yp-btn--secondary yp-btn--sm">
          Open developer settings
        </a>
      </Card>
      <Button
        variant="secondary"
        icon="logout"
        onClick={async () => {
          await api.auth.logout();
          setMe(null);
          router.replace('/');
        }}
      >
        Log out
      </Button>
    </div>
  );
}

function SafetySettings() {
  const { toast } = useSession();
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.me.moderation>>['items']>([]);
  const [blocked, setBlocked] = useState<{ id: string; displayName: string }[]>([]);
  const [appealFor, setAppealFor] = useState<string | null>(null);
  const [statement, setStatement] = useState('');
  useEffect(() => {
    api.me.moderation().then((r) => setItems(r.items));
    api.raw.get<{ items: { id: string; displayName: string }[] }>('/v1/me/blocked').then((r) => setBlocked(r.items));
  }, []);
  return (
    <div className="stack" id="moderation">
      <Card title="Decisions about your content">
        {items.length ? (
          <List>
            {items.map((c) => (
              <ListItem
                key={c.id}
                primary={`${c.target_type}: ${c.decision.replace('_', ' ')}`}
                secondary={c.appeal_status ? `Appeal ${c.appeal_status}` : c.status === 'decided' ? 'You can appeal this decision.' : 'Final'}
                end={
                  c.status === 'decided' && !c.appeal_status ? (
                    <Button size="sm" variant="secondary" onClick={() => setAppealFor(c.id)}>
                      Appeal
                    </Button>
                  ) : null
                }
              />
            ))}
          </List>
        ) : (
          <p className="muted">No actions have been taken on your content.</p>
        )}
      </Card>
      <Card title="Blocked accounts">
        {blocked.length ? (
          <List>
            {blocked.map((u) => (
              <ListItem
                key={u.id}
                primary={u.displayName}
                end={
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await api.users.unblock(u.id);
                      setBlocked((x) => x.filter((y) => y.id !== u.id));
                    }}
                  >
                    Unblock
                  </Button>
                }
              />
            ))}
          </List>
        ) : (
          <p className="muted">You haven't blocked anyone.</p>
        )}
      </Card>
      <Dialog
        open={!!appealFor}
        onClose={() => setAppealFor(null)}
        title="Appeal this decision"
        footer={
          <Button
            disabled={!statement.trim()}
            onClick={async () => {
              try {
                await api.raw.post('/v1/appeals', { caseId: appealFor, statement });
                toast('Appeal sent. A different reviewer will look at it.');
                setAppealFor(null);
                setItems((await api.me.moderation()).items);
              } catch (e) {
                toast(errorMessage(e));
              }
            }}
          >
            Send appeal
          </Button>
        }
      >
        <TextField
          label="Tell us why this decision is wrong"
          multiline
          value={statement}
          onChange={(e) => setStatement(e.currentTarget.value)}
          maxLength={2000}
        />
      </Dialog>
    </div>
  );
}

function TwoStepCard() {
  const { toast } = useSession();
  const [status, setStatus] = useState<{ enabled: boolean; recoveryCodesLeft: number } | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [disabling, setDisabling] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = () => api.mfa.status().then(setStatus);
  useEffect(() => {
    void load();
  }, []);
  if (!status) return null;

  return (
    <Card
      title="Two-step verification"
      subtitle={
        status.enabled ? `On. ${status.recoveryCodesLeft} recovery codes left.` : 'Protect your account with a code from an authenticator app when you sign in.'
      }
    >
      <div className="stack-sm">
        {err ? <Alert tone="danger">{err}</Alert> : null}
        {codes ? (
          <Alert tone="warning" title="Save your recovery codes">
            Each code works once if you lose your phone. They won't be shown again.
            <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 14, lineHeight: '22px', margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>
              {codes.join('\n')}
            </pre>
            <Button size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(codes.join('\n')).then(() => toast('Codes copied'))}>
              Copy codes
            </Button>
          </Alert>
        ) : null}
        {!status.enabled && !setup ? (
          <Button
            icon="shield"
            onClick={async () => {
              setErr(null);
              try {
                setSetup(await api.mfa.setup());
              } catch (e) {
                setErr(errorMessage(e));
              }
            }}
          >
            Turn on two-step verification
          </Button>
        ) : null}
        {setup ? (
          <form
            className="stack-sm"
            onSubmit={async (e) => {
              e.preventDefault();
              setErr(null);
              try {
                setCodes((await api.mfa.confirm(code)).recoveryCodes);
                setSetup(null);
                setCode('');
                await load();
              } catch (e2) {
                setErr(errorMessage(e2));
              }
            }}
          >
            <p style={{ margin: 0 }}>In your authenticator app, add an account with this key, or open the setup link on this device:</p>
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 15, letterSpacing: '.08em', wordBreak: 'break-all' }}>
              {setup.secret.match(/.{1,4}/g)?.join(' ')}
            </code>
            <a href={setup.otpauthUri}>Open in authenticator app</a>
            <TextField
              label="6-digit code from the app"
              value={code}
              onChange={(e) => setCode(e.currentTarget.value)}
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={6}
            />
            <div className="row">
              <Button type="submit" disabled={code.length !== 6}>
                Verify and turn on
              </Button>
              <Button variant="ghost" onClick={() => setSetup(null)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
        {status.enabled && !disabling ? (
          <Button variant="secondary" onClick={() => setDisabling(true)}>
            Turn off
          </Button>
        ) : null}
        {disabling ? (
          <form
            className="stack-sm"
            onSubmit={async (e) => {
              e.preventDefault();
              setErr(null);
              try {
                await api.mfa.disable(password, code);
                setDisabling(false);
                setPassword('');
                setCode('');
                setCodes(null);
                toast('Two-step verification is off');
                await load();
              } catch (e2) {
                setErr(errorMessage(e2));
              }
            }}
          >
            <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
            <TextField
              label="Code or recovery code"
              value={code}
              onChange={(e) => setCode(e.currentTarget.value)}
              autoComplete="one-time-code"
              maxLength={12}
            />
            <div className="row">
              <Button type="submit" variant="danger" disabled={!password || code.length < 6}>
                Turn off two-step verification
              </Button>
              <Button variant="ghost" onClick={() => setDisabling(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </Card>
  );
}

function ConnectedApps() {
  const { toast } = useSession();
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.oauth.connectedApps>>['items']>([]);
  const load = () => api.oauth.connectedApps().then((r) => setItems(r.items));
  useEffect(() => {
    void load();
  }, []);
  return (
    <Card title="Connected apps" subtitle="Apps you allowed to use your account with Sign in with YAPILAPI.">
      {items.length ? (
        <List>
          {items.map((a) => (
            <ListItem
              key={a.id}
              primary={a.name}
              secondary={`Can ${a.scopes.includes('write') ? 'read and post' : 'read'}`}
              end={
                <Button size="sm" variant="ghost" onClick={async () => (await api.oauth.disconnect(a.id), toast(`Disconnected ${a.name}`), await load())}>
                  Disconnect
                </Button>
              }
            />
          ))}
        </List>
      ) : (
        <p className="muted">No apps are connected.</p>
      )}
    </Card>
  );
}

function PasskeysCard() {
  const { toast, locale } = useSession();
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.passkeys.list>>['items']>([]);
  const load = () => api.passkeys.list().then((r) => setItems(r.items));
  useEffect(() => {
    void load();
  }, []);
  return (
    <Card title="Passkeys" subtitle="Sign in with your fingerprint, face or device PIN. Passkeys can't be phished and replace both your password and code.">
      <div className="stack-sm">
        {items.length ? (
          <List>
            {items.map((p) => (
              <ListItem
                key={p.id}
                primary={p.label}
                secondary={p.last_used_at ? `Used ${formatRelativeTime(p.last_used_at, locale)}` : 'Not used yet'}
                end={
                  <Button size="sm" variant="ghost" onClick={async () => (await api.passkeys.remove(p.id), await load())}>
                    Remove
                  </Button>
                }
              />
            ))}
          </List>
        ) : null}
        <Button
          icon="shield"
          onClick={async () => {
            try {
              const { options, challengeId } = await api.passkeys.registerOptions();
              const response = await startRegistration({ optionsJSON: options });
              await api.passkeys.registerVerify(challengeId, response, navigator.platform ? `Passkey on ${navigator.platform}` : 'Passkey');
              toast('Passkey added');
              await load();
            } catch (e) {
              if ((e as Error).name !== 'NotAllowedError') toast(errorMessage(e));
            }
          }}
        >
          Add a passkey
        </Button>
      </div>
    </Card>
  );
}

function BrowserPushCard() {
  const { toast } = useSession();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    if (!pushSupported()) return setOn(null);
    currentSubscription().then((s) => setOn(!!s));
  }, []);
  if (on === null) return null;
  return (
    <Card title="Browser notifications" subtitle="Get notified on this device even when YAPILAPI isn't open. Focus mode and paused notifications still apply.">
      <Switch
        label="Notifications on this browser"
        checked={on}
        onChange={async (v) => {
          if (!v) {
            await disableBrowserPush();
            setOn(false);
            return;
          }
          const r = await enableBrowserPush();
          if (r === 'enabled') setOn(true);
          else toast(r === 'denied' ? 'Notifications are blocked in your browser settings.' : "This browser or server doesn't support push notifications.");
        }}
      />
    </Card>
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
