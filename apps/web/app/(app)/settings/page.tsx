'use client';

import { IMAGE_ACCEPT, t as translate } from '@yapilapi/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Dialog, List, ListItem, Select, Switch, Tabs, TextField } from '@yapilapi/design-system';
import { NOTIFICATION_CATEGORIES, PROFILE_MODES, SUPPORTED_LOCALES, formatRelativeTime, type MessageKey, type TagPermission } from '@yapilapi/shared';
import { startRegistration } from '@simplewebauthn/browser';
import type { SharingSettings as SharingSettingsState } from '@yapilapi/api-client';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { currentSubscription, disableBrowserPush, enableBrowserPush, pushSupported } from '@/lib/push';
import { FamilyCard } from '@/components/Family';
import { CloseFriendsCard } from '@/components/CloseFriends';
import { PurchasesCard } from '@/components/Shop';
import { VerificationCard } from '@/components/Verification';
import { DataSaverCard } from '@/components/DataSaver';
import { HiddenWordsCard } from '@/components/HiddenWords';
import { TranslationCard } from '@/components/TranslationSettings';
import { useSession } from '../../providers';

export default function Settings() {
  const { t } = useSession();
  const [tab, setTab] = useState(() =>
    typeof location === 'undefined'
      ? 'profile'
      : location.hash === '#moderation'
        ? 'safety'
        : location.hash === '#close-friends'
          ? 'privacy'
          : location.hash === '#verification'
            ? 'security'
            : 'profile',
  );
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('settings.title')}</h1>
      </div>
      <Tabs
        id="settings-tabs"
        panelId="settings-panel"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'profile', label: t('settings.tab.profile') },
          { id: 'attention', label: t('settings.tab.attention') },
          { id: 'privacy', label: t('settings.tab.privacy') },
          { id: 'security', label: t('settings.tab.security') },
          { id: 'safety', label: t('settings.tab.safety') },
        ]}
      />
      <div role="tabpanel" id="settings-panel" aria-labelledby={`settings-tabs-${tab}`}>
        {tab === 'profile' ? (
          <div className="stack">
            <PlusAndInvites />
            <PurchasesCard />
            <ProfileSettings />
            <div id="data-saver">
              <DataSaverCard />
            </div>
            <div id="translation">
              <TranslationCard />
            </div>
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
  const { me, refresh, toast, locale, t } = useSession();
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
          const saved = await refresh();
          // In the language just chosen, not the one the page was showing.
          toast(translate('settings.profileSaved', saved?.locale ?? locale));
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
      <TextField label={t('auth.displayName')} name="displayName" defaultValue={profile.displayName} maxLength={60} error={fields.displayName} />
      <TextField label={t('settings.bio')} name="bio" multiline defaultValue={profile.bio} maxLength={300} error={fields.bio} />
      <Select label={t('settings.profileType')} name="mode" defaultValue={profile.mode}>
        {PROFILE_MODES.map((m) => (
          <option key={m} value={m}>
            {t(`settings.mode.${m}` as MessageKey)}
          </option>
        ))}
      </Select>
      <Select label={t('settings.language')} name="locale" defaultValue={me?.locale ?? 'en'}>
        {SUPPORTED_LOCALES.map((l) => (
          <option key={l} value={l}>
            {new Intl.DisplayNames([l], { type: 'language' }).of(l)}
          </option>
        ))}
      </Select>
      <Select label={t('settings.country')} name="country" defaultValue={me?.country ?? ''} hint={t('settings.countryHint')}>
        <option value="">{t('settings.notSet')}</option>
        {countries(locale).map(([code, name]) => (
          <option key={code} value={code}>
            {name}
          </option>
        ))}
      </Select>
      <label className="yp-check">
        <input type="checkbox" name="isPrivate" defaultChecked={profile.isPrivate} />
        <span>
          {t('settings.private')}
          <span className="yp-check__desc">{t('settings.privateHint')}</span>
        </span>
      </label>
      <Button type="submit" loading={busy}>
        {t('settings.saveProfile')}
      </Button>
    </form>
  );
}

function AttentionSettings() {
  const { toast, t } = useSession();
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
      <Card title={t('settings.feed.title')} subtitle={t('settings.feed.subtitle')}>
        <div className="stack">
          <Switch label={t('settings.friendsOnly')} checked={!!a.friendsOnly} onChange={(v) => setA('friendsOnly', v)} />
          <Switch label={t('settings.reducedRecs')} checked={!!a.reducedRecommendations} onChange={(v) => setA('reducedRecommendations', v)} />
          <Switch label={t('settings.focusMode')} checked={!!a.focusMode} onChange={(v) => setA('focusMode', v)} />
          <Switch label={t('settings.quietMode')} checked={!!a.quietMode} onChange={(v) => setA('quietMode', v)} />
          <Select
            label={t('settings.budget')}
            value={String(a.dailyTimeBudgetMinutes ?? '')}
            onChange={(e) => setA('dailyTimeBudgetMinutes', e.currentTarget.value ? Number(e.currentTarget.value) : null)}
          >
            <option value="">{t('settings.noLimit')}</option>
            {[15, 30, 45, 60, 90, 120].map((m) => (
              <option key={m} value={m}>
                {t('settings.minutes', { count: m })}
              </option>
            ))}
          </Select>
          <div className="row">
            <Button size="sm" variant="secondary" onClick={() => setA('notificationsPausedUntil', new Date(Date.now() + 8 * 3600_000).toISOString())}>
              {t('settings.pause8h')}
            </Button>
            {a.notificationsPausedUntil && new Date(a.notificationsPausedUntil) > new Date() ? (
              <Button size="sm" variant="ghost" onClick={() => setA('notificationsPausedUntil', null)}>
                {t('settings.resumeNow')}
              </Button>
            ) : null}
          </div>
        </div>
      </Card>
      <Card title={t('notifications.title')} subtitle={t('settings.notificationsHint')}>
        <div className="stack-sm">
          {NOTIFICATION_CATEGORIES.map((c) => (
            <Switch
              key={c}
              label={t(`settings.cat.${c}` as MessageKey)}
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

const PURPOSES: Record<string, MessageKey> = {
  personalization: 'settings.purpose.personalization',
  ai_processing: 'settings.purpose.ai_processing',
  advertising: 'settings.purpose.advertising',
  analytics: 'settings.purpose.analytics',
};

/** Rows of "What we hold about you", named by the API's column names. */
const HELD: Record<string, MessageKey> = {
  posts: 'settings.held.posts',
  comments: 'settings.held.comments',
  messages: 'settings.held.messages',
  media: 'settings.held.media',
  ai_memories: 'settings.held.ai_memories',
  active_sessions: 'settings.held.active_sessions',
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

const TAG_CHOICES: { id: TagPermission; label: MessageKey }[] = [
  { id: 'everyone', label: 'visibility.public' },
  { id: 'following', label: 'settings.tags.following' },
  { id: 'nobody', label: 'settings.tags.nobody' },
];

/** Who may tag you in photos. */
function TaggingSettings() {
  const { toast, t } = useSession();
  const [allowFrom, setAllowFrom] = useState<TagPermission | null>(null);
  useEffect(() => {
    api.me.tagging().then(
      (r) => setAllowFrom(r.allowFrom),
      () => {},
    );
  }, []);
  if (!allowFrom) return null;
  const set = async (v: TagPermission) => {
    const before = allowFrom;
    setAllowFrom(v);
    try {
      setAllowFrom((await api.me.setTagging(v)).allowFrom);
    } catch (e) {
      setAllowFrom(before);
      toast(errorMessage(e));
    }
  };
  return (
    <Card title={t('settings.tags.title')}>
      <fieldset className="stack-sm" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="yp-field__label">{t('settings.tags.who')}</legend>
        {TAG_CHOICES.map((c) => (
          <label key={c.id} className="row" style={{ gap: 8 }}>
            <input type="radio" name="tag-permission" value={c.id} checked={allowFrom === c.id} onChange={() => set(c.id)} />
            {t(c.label)}
          </label>
        ))}
        <p className="muted setting-hint">{t('settings.tags.hint')}</p>
      </fieldset>
    </Card>
  );
}

function PrivacyCenter() {
  const { toast, setMe, t } = useSession();
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
      <CloseFriendsCard />
      <Card title={t('settings.circles.title')}>
        <p className="muted" style={{ marginTop: 0 }}>
          {t('settings.circles.body')}
        </p>
        <Link href="/circles" className="yp-btn yp-btn--secondary yp-btn--sm">
          {t('settings.circles.manage')}
        </Link>
      </Card>
      <Card title={t('settings.archive.title')}>
        <p className="muted" style={{ marginTop: 0 }}>
          {t('settings.archive.body')}
        </p>
        <Link href="/archive" className="yp-btn yp-btn--secondary yp-btn--sm">
          {t('settings.archive.open')}
        </Link>
      </Card>
      <SharingSettings />
      <TaggingSettings />
      <Card title={t('settings.held.title')}>
        <div className="stats">
          {Object.entries(data.dataSummary).map(([k, v]) => (
            <div key={k} className="yp-stat">
              <span className="yp-stat__label">{HELD[k] ? t(HELD[k]) : k.replace(/_/g, ' ')}</span>
              <span className="yp-stat__value">{v}</span>
            </div>
          ))}
        </div>
      </Card>
      <Card title={t('settings.dataUse.title')}>
        <div className="stack-sm">
          {Object.entries(PURPOSES).map(([p, label]) => (
            <Switch
              key={p}
              label={t(label)}
              checked={granted(p)}
              onChange={async (v) => {
                await api.me.setConsent(p, v).catch((e) => toast(errorMessage(e)));
                await reload();
              }}
            />
          ))}
        </div>
      </Card>
      <Card title={t('settings.memory.title')} subtitle={t('settings.memory.subtitle')}>
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
                      {t('settings.delete')}
                    </Button>
                  }
                />
              ))}
            </List>
          ) : (
            <p className="muted">{t('settings.memory.none')}</p>
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
              label={t('settings.memory.add')}
              value={memory}
              onChange={(e) => setMemory(e.currentTarget.value)}
              maxLength={1000}
              style={{ flex: 1 }}
            />
            <Button type="submit" size="sm" disabled={!memory.trim()}>
              {t('settings.add')}
            </Button>
          </form>
        </div>
      </Card>
      <ConnectedApps />
      <Card title={t('settings.data.title')}>
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
            {t('privacy.export')}
          </Button>
          <Button variant="danger" icon="trash" onClick={() => setDeleting(true)}>
            {t('privacy.delete')}
          </Button>
        </div>
      </Card>
      <Dialog
        open={deleting}
        onClose={() => setDeleting(false)}
        title={t('settings.deleteAccount.title')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleting(false)}>
              {t('common.cancel')}
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
              {t('settings.deleteAccount.confirm')}
            </Button>
          </>
        }
      >
        <div className="stack-sm">
          <p style={{ margin: 0 }}>{t('settings.deleteAccount.body')}</p>
          {err ? <Alert tone="danger">{err}</Alert> : null}
          <TextField
            label={t('settings.deleteAccount.password')}
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
  const { toast, setMe, locale, t } = useSession();
  const router = useRouter();
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof api.auth.sessions>>['items']>([]);
  const load = () => api.auth.sessions().then((r) => setSessions(r.items));
  useEffect(() => {
    void load();
  }, []);
  return (
    <div className="stack">
      <VerificationCard />
      <Card title={t('settings.sessions.title')}>
        <List>
          {sessions.map((s) => (
            <ListItem
              key={s.id}
              primary={s.current ? t('settings.sessions.thisDevice', { device: s.device }) : s.device}
              secondary={t('settings.sessions.meta', { ip: s.ip ?? t('settings.sessions.unknownIp'), time: formatRelativeTime(s.last_seen_at, locale) })}
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
                    {t('settings.signOut')}
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
      <Card title={t('settings.dev.title')} subtitle={t('settings.dev.subtitle')}>
        <a href="/developers" className="yp-btn yp-btn--secondary yp-btn--sm">
          {t('settings.dev.open')}
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
        {t('auth.logout')}
      </Button>
    </div>
  );
}

function SafetySettings() {
  const { toast, t } = useSession();
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
      <Card title={t('settings.moderation.title')}>
        {items.length ? (
          <List>
            {items.map((c) => (
              <ListItem
                key={c.id}
                primary={`${c.target_type}: ${c.decision.replace('_', ' ')}`}
                secondary={
                  c.appeal_status
                    ? t('settings.appeal.status', { status: c.appeal_status })
                    : c.status === 'decided'
                      ? t('settings.appeal.can')
                      : t('settings.appeal.final')
                }
                end={
                  c.status === 'decided' && !c.appeal_status ? (
                    <Button size="sm" variant="secondary" onClick={() => setAppealFor(c.id)}>
                      {t('settings.appeal')}
                    </Button>
                  ) : null
                }
              />
            ))}
          </List>
        ) : (
          <p className="muted">{t('settings.moderation.none')}</p>
        )}
      </Card>
      <Card title={t('settings.blocked.title')}>
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
                    {t('profile.unblock')}
                  </Button>
                }
              />
            ))}
          </List>
        ) : (
          <p className="muted">{t('settings.blocked.none')}</p>
        )}
      </Card>
      <HiddenWordsCard />
      <Dialog
        open={!!appealFor}
        onClose={() => setAppealFor(null)}
        title={t('settings.appeal.title')}
        footer={
          <Button
            disabled={!statement.trim()}
            onClick={async () => {
              try {
                await api.raw.post('/v1/appeals', { caseId: appealFor, statement });
                toast(t('settings.appeal.sent'));
                setAppealFor(null);
                setItems((await api.me.moderation()).items);
              } catch (e) {
                toast(errorMessage(e));
              }
            }}
          >
            {t('settings.appeal.send')}
          </Button>
        }
      >
        <TextField label={t('settings.appeal.why')} multiline value={statement} onChange={(e) => setStatement(e.currentTarget.value)} maxLength={2000} />
      </Dialog>
    </div>
  );
}

function TwoStepCard() {
  const { toast, t, tp } = useSession();
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
    <Card title={t('settings.twoStep.title')} subtitle={status.enabled ? tp('settings.twoStep.on', status.recoveryCodesLeft) : t('settings.twoStep.offHint')}>
      <div className="stack-sm">
        {err ? <Alert tone="danger">{err}</Alert> : null}
        {codes ? (
          <Alert tone="warning" title={t('settings.twoStep.saveCodes')}>
            {t('settings.twoStep.codesHint')}
            <pre style={{ fontFamily: 'var(--font-mono)', fontSize: 14, lineHeight: '22px', margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>
              {codes.join('\n')}
            </pre>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => navigator.clipboard?.writeText(codes.join('\n')).then(() => toast(t('settings.twoStep.copied')))}
            >
              {t('settings.twoStep.copy')}
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
            {t('settings.twoStep.turnOn')}
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
            <p style={{ margin: 0 }}>{t('settings.twoStep.addKey')}</p>
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 15, letterSpacing: '.08em', wordBreak: 'break-all' }}>
              {setup.secret.match(/.{1,4}/g)?.join(' ')}
            </code>
            <a href={setup.otpauthUri}>{t('settings.twoStep.openApp')}</a>
            <TextField
              label={t('settings.twoStep.code')}
              value={code}
              onChange={(e) => setCode(e.currentTarget.value)}
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={6}
            />
            <div className="row">
              <Button type="submit" disabled={code.length !== 6}>
                {t('settings.twoStep.verify')}
              </Button>
              <Button variant="ghost" onClick={() => setSetup(null)}>
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        ) : null}
        {status.enabled && !disabling ? (
          <Button variant="secondary" onClick={() => setDisabling(true)}>
            {t('settings.twoStep.turnOff')}
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
                toast(t('settings.twoStep.isOff'));
                await load();
              } catch (e2) {
                setErr(errorMessage(e2));
              }
            }}
          >
            <TextField
              label={t('auth.password')}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />
            <TextField
              label={t('settings.twoStep.codeOrRecovery')}
              value={code}
              onChange={(e) => setCode(e.currentTarget.value)}
              autoComplete="one-time-code"
              maxLength={12}
            />
            <div className="row">
              <Button type="submit" variant="danger" disabled={!password || code.length < 6}>
                {t('settings.twoStep.turnOffFull')}
              </Button>
              <Button variant="ghost" onClick={() => setDisabling(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </Card>
  );
}

function ConnectedApps() {
  const { toast, t } = useSession();
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.oauth.connectedApps>>['items']>([]);
  const load = () => api.oauth.connectedApps().then((r) => setItems(r.items));
  useEffect(() => {
    void load();
  }, []);
  return (
    <Card title={t('settings.apps.title')} subtitle={t('settings.apps.subtitle')}>
      {items.length ? (
        <List>
          {items.map((a) => (
            <ListItem
              key={a.id}
              primary={a.name}
              secondary={a.scopes.includes('write') ? t('settings.apps.readPost') : t('settings.apps.read')}
              end={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => (await api.oauth.disconnect(a.id), toast(t('settings.apps.disconnected', { name: a.name })), await load())}
                >
                  {t('settings.apps.disconnect')}
                </Button>
              }
            />
          ))}
        </List>
      ) : (
        <p className="muted">{t('settings.apps.none')}</p>
      )}
    </Card>
  );
}

function PasskeysCard() {
  const { toast, locale, t } = useSession();
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.passkeys.list>>['items']>([]);
  const load = () => api.passkeys.list().then((r) => setItems(r.items));
  useEffect(() => {
    void load();
  }, []);
  return (
    <Card title={t('settings.passkeys.title')} subtitle={t('settings.passkeys.subtitle')}>
      <div className="stack-sm">
        {items.length ? (
          <List>
            {items.map((p) => (
              <ListItem
                key={p.id}
                primary={p.label}
                secondary={p.last_used_at ? t('settings.passkeys.used', { time: formatRelativeTime(p.last_used_at, locale) }) : t('settings.passkeys.notUsed')}
                end={
                  <Button size="sm" variant="ghost" onClick={async () => (await api.passkeys.remove(p.id), await load())}>
                    {t('dataSaver.remove')}
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
              toast(t('settings.passkeys.added'));
              await load();
            } catch (e) {
              if ((e as Error).name !== 'NotAllowedError') toast(errorMessage(e));
            }
          }}
        >
          {t('settings.passkeys.add')}
        </Button>
      </div>
    </Card>
  );
}

function BrowserPushCard() {
  const { toast, t } = useSession();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    if (!pushSupported()) return setOn(null);
    currentSubscription().then((s) => setOn(!!s));
  }, []);
  if (on === null) return null;
  return (
    <Card title={t('settings.push.title')} subtitle={t('settings.push.subtitle')}>
      <Switch
        label={t('settings.push.label')}
        checked={on}
        onChange={async (v) => {
          if (!v) {
            await disableBrowserPush();
            setOn(false);
            return;
          }
          const r = await enableBrowserPush();
          if (r === 'enabled') setOn(true);
          else toast(r === 'denied' ? t('settings.push.denied') : t('settings.push.unsupported'));
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
