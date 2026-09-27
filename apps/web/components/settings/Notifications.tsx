'use client';

import { useEffect, useState } from 'react';
import { Button, Card, Select, Switch, TextField } from '@yapilapi/design-system';
import { NOTIFICATION_CATEGORIES, type InteractionSettings, type MessageKey } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { currentSubscription, disableBrowserPush, enableBrowserPush, pushSupported } from '@/lib/push';
import { useSession } from '@/app/providers';
import { Anchor } from './Shell';

type Prefs = { notifications: Record<string, boolean>; attention: Record<string, any> };

function usePrefs() {
  const { toast } = useSession();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  useEffect(() => {
    api.me.preferences().then(setPrefs, (e) => toast(errorMessage(e)));
  }, [toast]);
  const setAttention = async (k: string, v: unknown) => {
    setPrefs((p) => (p ? { ...p, attention: { ...p.attention, [k]: v } } : p));
    try {
      await api.me.setAttention({ [k]: v });
    } catch (e) {
      toast(errorMessage(e));
    }
  };
  return { prefs, setPrefs, setAttention };
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
  const { prefs, setAttention } = usePrefs();
  if (!prefs) return null;
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
  const [settings, setSettings] = useState<InteractionSettings | null>(null);
  const [start, setStart] = useState('22:00');
  const [end, setEnd] = useState('07:00');
  useEffect(() => {
    api.me.interactions().then(
      (r) => {
        setSettings(r.settings);
        if (r.settings.quietHours) {
          setStart(r.settings.quietHours.start);
          setEnd(r.settings.quietHours.end);
        }
      },
      (e) => toast(errorMessage(e)),
    );
  }, [toast]);
  if (!settings) return null;
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
  const { prefs, setPrefs } = usePrefs();
  if (!prefs) return null;
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

/** "Your feed, your rules": friends only, fewer recommendations, focus and quiet modes, a daily time budget. */
export function FeedCard() {
  const { t } = useSession();
  const { prefs, setAttention } = usePrefs();
  if (!prefs) return null;
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
