'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button, Card, Select, Switch, TextField } from '@yapilapi/design-system';
import { NOTIFICATION_CATEGORIES, TODAY_HOURS, type InteractionSettings, type MessageKey, type TodaySettings, type WeeklyWrapSettings } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { currentSubscription, disableBrowserPush, enableBrowserPush, pushSupported } from '@/lib/push';
import { useSession } from '@/app/providers';
import { Anchor } from './Shell';

type Prefs = { notifications: Record<string, boolean>; attention: Record<string, any> };

/** A card whose settings couldn't load: why, and Try again (rather than the card quietly missing). */
function LoadFailed({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  const { t } = useSession();
  return (
    <Card title={title}>
      <div className="row">
        <span role="alert">{message}</span>
        <Button size="sm" variant="secondary" onClick={onRetry}>
          {t('m.common.retry')}
        </Button>
      </div>
    </Card>
  );
}

/** Loads settings once (and again on retry); `error` says why they couldn't load. */
function useLoaded<T>(load: () => Promise<T>) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setError(null);
    load().then(setValue, (e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);
  return { value, setValue, error, retry: () => setAttempt((n) => n + 1) };
}

function usePrefs() {
  const { toast } = useSession();
  const { value: prefs, setValue: setPrefs, error, retry } = useLoaded<Prefs>(() => api.me.preferences());
  const setAttention = async (k: string, v: unknown) => {
    setPrefs((p) => (p ? { ...p, attention: { ...p.attention, [k]: v } } : p));
    try {
      await api.me.setAttention({ [k]: v });
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  return { prefs, setPrefs, setAttention, error, retry };
}

/** Notifications on this browser, even when YAPILAPI isn't open. */
export function BrowserPushCard() {
  const { toast, t } = useSession();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    if (!pushSupported()) return setOn(null);
    currentSubscription().then((s) => setOn(!!s));
  }, []);
  if (on === null) return null;
  return (
    <Anchor id="push">
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
    </Anchor>
  );
}

/** Pause everything but security notifications for 8 hours, and resume early. */
export function PauseCard() {
  const { t, locale } = useSession();
  const { prefs, setAttention, error, retry } = usePrefs();
  if (!prefs) return error ? <LoadFailed title={t('st.pause.title')} message={error} onRetry={retry} /> : null;
  const until = prefs.attention.notificationsPausedUntil ? new Date(prefs.attention.notificationsPausedUntil) : null;
  const paused = !!until && until > new Date();
  return (
    <Anchor id="pause">
      <Card
        title={t('st.pause.title')}
        subtitle={
          paused
            ? t('m.settings.pausedUntil', { time: new Intl.DateTimeFormat(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(until!) })
            : t('st.pause.desc')
        }
      >
        <div className="row">
          {paused ? (
            <Button size="sm" variant="secondary" onClick={() => setAttention('notificationsPausedUntil', null)}>
              {t('settings.resumeNow')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              icon="moon"
              onClick={() => setAttention('notificationsPausedUntil', new Date(Date.now() + 8 * 3600_000).toISOString())}
            >
              {t('settings.pause8h')}
            </Button>
          )}
        </div>
      </Card>
    </Anchor>
  );
}

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Quiet hours: pushes wait until they end, every day, in your time zone. */
export function QuietHoursCard() {
  const { t, toast } = useSession();
  const [start, setStart] = useState('22:00');
  const [end, setEnd] = useState('07:00');
  const {
    value: settings,
    setValue: setSettings,
    error,
    retry,
  } = useLoaded(() =>
    api.me.interactions().then((r) => {
      if (r.settings.quietHours) {
        setStart(r.settings.quietHours.start);
        setEnd(r.settings.quietHours.end);
      }
      return r.settings;
    }),
  );
  if (!settings) return error ? <LoadFailed title={t('st.quiet.title')} message={error} onRetry={retry} /> : null;
  const on = !!settings.quietHours;
  const save = async (quietHours: InteractionSettings['quietHours']) => {
    const before = settings;
    setSettings({ ...settings, quietHours });
    try {
      setSettings((await api.me.setInteractions({ quietHours })).settings);
      toast(t('st.quiet.saved'));
    } catch (e) {
      setSettings(before);
      toast(errorMessage(e));
    }
  };
  return (
    <Anchor id="quiet">
      <Card title={t('st.quiet.title')} subtitle={t('st.quiet.desc')}>
        <div className="stack-sm">
          <Switch label={t('st.quiet.switch')} checked={on} onChange={(v) => save(v ? { start, end, timezone: zone() } : null)} />
          {on ? (
            <form
              className="stack-sm"
              onSubmit={(e) => {
                e.preventDefault();
                void save({ start, end, timezone: zone() });
              }}
            >
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <TextField label={t('st.quiet.from')} type="time" value={start} onChange={(e) => setStart(e.currentTarget.value)} required />
                <TextField label={t('st.quiet.until')} type="time" value={end} onChange={(e) => setEnd(e.currentTarget.value)} required />
                <Button type="submit" variant="secondary" disabled={start === end}>
                  {t('common.save')}
                </Button>
              </div>
              <p className="muted setting-hint">{t('st.quiet.zone', { zone: settings.quietHours?.timezone ?? zone() })}</p>
            </form>
          ) : null}
        </div>
      </Card>
    </Anchor>
  );
}

/** Which kinds of notifications you get. Security ones are always on. */
export function CategoriesCard() {
  const { toast, t } = useSession();
  const { prefs, setPrefs, error, retry } = usePrefs();
  if (!prefs) return error ? <LoadFailed title={t('st.categories.title')} message={error} onRetry={retry} /> : null;
  return (
    <Anchor id="categories">
      <Card title={t('st.categories.title')} subtitle={t('settings.notificationsHint')}>
        <div className="stack-sm">
          {NOTIFICATION_CATEGORIES.map((c) => (
            <Switch
              key={c}
              label={t(`settings.cat.${c}` as MessageKey)}
              checked={prefs.notifications[c] !== false}
              disabled={c === 'security'}
              onChange={async (v) => {
                setPrefs((p) => (p ? { ...p, notifications: { ...p.notifications, [c]: v } } : p));
                await api.me.setNotificationPrefs({ [c]: v }).catch((e) => toast(errorMessage(e)));
              }}
            />
          ))}
        </div>
      </Card>
    </Anchor>
  );
}

/**
 * Weekly wrap: a private look back at your week on Sunday evening in your time zone, and
 * whether to be told when it's ready (only while it's made at all).
 */
export function WeeklyWrapCard() {
  const { t, toast } = useSession();
  const { value: settings, setValue: setSettings, error, retry } = useLoaded<WeeklyWrapSettings>(() => api.wraps.settings().then((r) => r.settings));
  if (!settings) return error ? <LoadFailed title={t('wrap.settings.title')} message={error} onRetry={retry} /> : null;
  const save = async (patch: { enabled?: boolean; notify?: boolean }) => {
    const before = settings;
    setSettings({ ...settings, ...patch });
    try {
      setSettings((await api.wraps.updateSettings(patch)).settings);
    } catch (e) {
      setSettings(before);
      toast(errorMessage(e));
    }
  };
  return (
    <Anchor id="weekly-wrap">
      <Card title={t('wrap.settings.title')} subtitle={t('wrap.settings.desc')}>
        <div className="stack-sm">
          <Switch label={t('wrap.settings.enabled')} checked={settings.enabled} onChange={(v) => void save({ enabled: v })} />
          <Switch
            label={t('wrap.settings.notify')}
            checked={settings.enabled && settings.notify}
            disabled={!settings.enabled}
            onChange={(v) => void save({ notify: v })}
          />
          <p className="muted setting-hint">{t('wrap.settings.timezone', { zone: settings.timezone })}</p>
          <p className="setting-hint">
            <Link href="/wraps">{t('wrap.past')}</Link>
          </p>
        </div>
      </Card>
    </Anchor>
  );
}

/**
 * Yapilapi Today: a short morning briefing of what your people and your city are talking about,
 * from the hour you choose (in your time zone), with your city or not, and whether to be told
 * when it's ready (off by default; quiet hours hold the push).
 */
export function TodaySettingsCard() {
  const { t, toast, flags, locale } = useSession();
  const { value: settings, setValue: setSettings, error, retry } = useLoaded<TodaySettings>(() => api.today.settings().then((r) => r.settings));
  if (!flags.TODAY) return null;
  if (!settings) return error ? <LoadFailed title={t('today.title')} message={error} onRetry={retry} /> : null;
  const save = async (patch: Partial<Pick<TodaySettings, 'enabled' | 'hour' | 'city' | 'notify'>>) => {
    const before = settings;
    setSettings({ ...settings, ...patch });
    try {
      setSettings((await api.today.updateSettings(patch)).settings);
    } catch (e) {
      setSettings(before);
      toast(errorMessage(e));
    }
  };
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
  return (
    <Anchor id="today">
      <Card title={t('today.title')} subtitle={t('today.settings.desc')}>
        <div className="stack-sm">
          <Switch label={t('today.settings.enabled')} checked={settings.enabled} onChange={(v) => void save({ enabled: v })} />
          <Select
            label={t('today.settings.hour')}
            value={String(settings.hour)}
            disabled={!settings.enabled}
            onChange={(e) => void save({ hour: Number(e.currentTarget.value) })}
          >
            {TODAY_HOURS.map((h) => (
              <option key={h} value={h}>
                {time.format(new Date(2026, 0, 1, h, 0))}
              </option>
            ))}
          </Select>
          <Switch
            label={t('today.settings.city')}
            checked={settings.enabled && settings.city}
            disabled={!settings.enabled}
            onChange={(v) => void save({ city: v })}
          />
          <Switch
            label={t('today.settings.notify')}
            checked={settings.enabled && settings.notify}
            disabled={!settings.enabled}
            onChange={(v) => void save({ notify: v })}
          />
          <p className="muted setting-hint">{t('wrap.settings.timezone', { zone: settings.timezone })}</p>
        </div>
      </Card>
    </Anchor>
  );
}

/** "Your feed, your rules": friends only, fewer recommendations, focus and quiet modes, a daily time budget. */
export function FeedCard() {
  const { t } = useSession();
  const { prefs, setAttention, error, retry } = usePrefs();
  if (!prefs) return error ? <LoadFailed title={t('settings.feed.title')} message={error} onRetry={retry} /> : null;
  const a = prefs.attention;
  return (
    <Card title={t('settings.feed.title')} subtitle={t('settings.feed.subtitle')}>
      <div className="stack">
        <Switch label={t('settings.friendsOnly')} checked={!!a.friendsOnly} onChange={(v) => setAttention('friendsOnly', v)} />
        <Switch label={t('settings.reducedRecs')} checked={!!a.reducedRecommendations} onChange={(v) => setAttention('reducedRecommendations', v)} />
        <Switch label={t('settings.focusMode')} checked={!!a.focusMode} onChange={(v) => setAttention('focusMode', v)} />
        <Switch label={t('settings.quietMode')} checked={!!a.quietMode} onChange={(v) => setAttention('quietMode', v)} />
        <Select
          label={t('settings.budget')}
          value={String(a.dailyTimeBudgetMinutes ?? '')}
          onChange={(e) => setAttention('dailyTimeBudgetMinutes', e.currentTarget.value ? Number(e.currentTarget.value) : null)}
        >
          <option value="">{t('settings.noLimit')}</option>
          {[15, 30, 45, 60, 90, 120].map((m) => (
            <option key={m} value={m}>
              {t('settings.minutes', { count: m })}
            </option>
          ))}
        </Select>
      </div>
    </Card>
  );
}
