import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { NOTIFICATION_CATEGORIES } from '../../../packages/shared/src/constants';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import { client, errorMessage } from './api';
import { Chip, ChipRow } from './chips';
import { useT } from './i18n';
import { space } from './theme';
import { Button, Card, Loading, Notice, Row, SwitchRow, Title, useColors } from './ui';

/**
 * The rest of the web app's settings on the phone (same endpoints as apps/web/app/(app)/settings):
 * notification categories and pausing, the feed controls, other consents, blocked accounts and
 * where you're signed in.
 */

type Prefs = { notifications: Record<string, boolean>; attention: Record<string, unknown> };

function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void client()
      .then((api) => api.me.preferences())
      .then(setPrefs, (e) => setError(errorMessage(e)));
  }, []);
  return { prefs, setPrefs, error, setError };
}

/** Which kinds of notifications you get (security ones always), and pausing them for 8 hours. */
export function NotificationSettings() {
  const c = useColors();
  const { t, dateTime } = useT();
  const { prefs, setPrefs, error, setError } = usePrefs();
  const pausedUntil = typeof prefs?.attention.notificationsPausedUntil === 'string' ? new Date(prefs.attention.notificationsPausedUntil) : null;
  const paused = !!pausedUntil && pausedUntil > new Date();

  const setCategory = async (cat: string, on: boolean) => {
    if (!prefs) return;
    const before = prefs;
    setPrefs({ ...prefs, notifications: { ...prefs.notifications, [cat]: on } });
    setError(null);
    try {
      await (await client()).me.setNotificationPrefs({ [cat]: on });
    } catch (e) {
      setPrefs(before);
      setError(errorMessage(e));
    }
  };

  const setPause = async (until: string | null) => {
    if (!prefs) return;
    const before = prefs;
    setPrefs({ ...prefs, attention: { ...prefs.attention, notificationsPausedUntil: until } });
    setError(null);
    try {
      await (await client()).me.setAttention({ notificationsPausedUntil: until });
    } catch (e) {
      setPrefs(before);
      setError(errorMessage(e));
    }
  };

  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={t('settings.notificationsHint')}>{t('notifications.title')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {prefs ? (
        <>
          {paused ? (
            <View style={{ gap: space[2] }}>
              <Text accessibilityLiveRegion="polite" style={{ color: c.ink }}>
                {t('m.settings.pausedUntil', { time: dateTime(pausedUntil!) })}
              </Text>
              <Button label={t('settings.resumeNow')} size="sm" variant="secondary" style={{ alignSelf: 'flex-start' }} onPress={() => setPause(null)} />
            </View>
          ) : (
            <Button
              label={t('settings.pause8h')}
              size="sm"
              variant="secondary"
              icon="moon-outline"
              style={{ alignSelf: 'flex-start' }}
              onPress={() => setPause(new Date(Date.now() + 8 * 3600_000).toISOString())}
            />
          )}
          {NOTIFICATION_CATEGORIES.map((cat) => (
            <SwitchRow
              key={cat}
              label={t(`settings.cat.${cat}` as MessageKey)}
              value={prefs.notifications[cat] !== false}
              disabled={cat === 'security'}
              onValueChange={(v) => void setCategory(cat, v)}
            />
          ))}
        </>
      ) : !error ? (
        <Loading />
      ) : null}
    </Card>
  );
}

const BUDGETS = [15, 30, 45, 60, 90, 120];

/** "Your feed, your rules": friends only, fewer recommendations, focus and quiet modes, a daily time budget. */
export function FeedSettings() {
  const { t } = useT();
  const { prefs, setPrefs, error, setError } = usePrefs();
  const a = prefs?.attention ?? {};

  const set = async (key: string, value: unknown) => {
    if (!prefs) return;
    const before = prefs;
    setPrefs({ ...prefs, attention: { ...prefs.attention, [key]: value } });
    setError(null);
    try {
      await (await client()).me.setAttention({ [key]: value });
    } catch (e) {
      setPrefs(before);
      setError(errorMessage(e));
    }
  };

  const budget = typeof a.dailyTimeBudgetMinutes === 'number' ? a.dailyTimeBudgetMinutes : null;
  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={t('settings.feed.subtitle')}>{t('settings.feed.title')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {prefs ? (
        <>
          <SwitchRow label={t('settings.friendsOnly')} value={!!a.friendsOnly} onValueChange={(v) => void set('friendsOnly', v)} />
          <SwitchRow label={t('settings.reducedRecs')} value={!!a.reducedRecommendations} onValueChange={(v) => void set('reducedRecommendations', v)} />
          <SwitchRow label={t('settings.focusMode')} value={!!a.focusMode} onValueChange={(v) => void set('focusMode', v)} />
          <SwitchRow label={t('settings.quietMode')} value={!!a.quietMode} onValueChange={(v) => void set('quietMode', v)} />
          <Title>{t('settings.budget')}</Title>
          <ChipRow radios label={t('settings.budget')}>
            <Chip radio label={t('settings.noLimit')} selected={budget === null} onPress={() => void set('dailyTimeBudgetMinutes', null)} />
            {BUDGETS.map((m) => (
              <Chip key={m} radio label={t('settings.minutes', { count: m })} selected={budget === m} onPress={() => void set('dailyTimeBudgetMinutes', m)} />
            ))}
          </ChipRow>
        </>
      ) : !error ? (
        <Loading />
      ) : null}
    </Card>
  );
}

const PURPOSES: { id: string; label: MessageKey }[] = [
  { id: 'personalization', label: 'settings.purpose.personalization' },
  { id: 'ai_processing', label: 'settings.purpose.ai_processing' },
  { id: 'analytics', label: 'settings.purpose.analytics' },
];

/** How your data is used: personalization, the assistant's memory and usage analytics (advertising has its own card). */
export function DataUseSettings() {
  const { t } = useT();
  const [consents, setConsents] = useState<Record<string, boolean> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void client()
      .then((api) => api.me.privacy())
      .then(
        (r) => setConsents(Object.fromEntries(r.consents.map((x) => [x.purpose, x.granted]))),
        (e) => setError(errorMessage(e)),
      );
  }, []);
  const set = async (purpose: string, granted: boolean) => {
    if (!consents) return;
    const before = consents;
    setConsents({ ...consents, [purpose]: granted });
    setError(null);
    try {
      await (await client()).me.setConsent(purpose, granted);
    } catch (e) {
      setConsents(before);
      setError(errorMessage(e));
    }
  };
  return (
    <Card style={{ gap: space[3] }}>
      <Title>{t('settings.dataUse.title')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {consents ? (
        PURPOSES.map((p) => <SwitchRow key={p.id} label={t(p.label)} value={!!consents[p.id]} onValueChange={(v) => void set(p.id, v)} />)
      ) : !error ? (
        <Loading />
      ) : null}
    </Card>
  );
}

/** People you blocked, each with Unblock. */
export function BlockedAccounts() {
  const c = useColors();
  const { t } = useT();
  const [items, setItems] = useState<{ id: string; displayName: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void client()
      .then((api) => api.raw.get<{ items: { id: string; displayName: string }[] }>('/v1/me/blocked'))
      .then(
        (r) => setItems(r.items),
        (e) => (setItems([]), setError(errorMessage(e))),
      );
  }, []);
  return (
    <Card style={{ gap: space[3] }}>
      <Title>{t('settings.blocked.title')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {items === null ? (
        <Loading />
      ) : items.length ? (
        items.map((u) => (
          <View key={u.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 44 }}>
            <Text style={{ color: c.ink, fontSize: 15, flex: 1 }} numberOfLines={1}>
              {u.displayName}
            </Text>
            <Button
              label={t('profile.unblock')}
              size="sm"
              variant="secondary"
              onPress={async () => {
                setError(null);
                try {
                  await (await client()).users.unblock(u.id);
                  setItems((cur) => cur?.filter((x) => x.id !== u.id) ?? cur);
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            />
          </View>
        ))
      ) : (
        <Text style={{ color: c.inkMuted }}>{t('settings.blocked.none')}</Text>
      )}
    </Card>
  );
}

type SignIn = { id: string; device: string; ip: string; last_seen_at: string; current: boolean };

/** Where you're signed in; any other device can be signed out from here. */
export function SessionsCard() {
  const { t, timeAgo } = useT();
  const [items, setItems] = useState<SignIn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    void client()
      .then((api) => api.auth.sessions())
      .then(
        (r) => setItems(r.items),
        (e) => (setItems([]), setError(errorMessage(e))),
      );
  useEffect(load, []);
  return (
    <Card style={{ gap: space[3] }}>
      <Title>{t('settings.sessions.title')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {items === null ? (
        <Loading />
      ) : (
        items.map((s) => (
          <Row
            key={s.id}
            title={s.current ? t('settings.sessions.thisDevice', { device: s.device }) : s.device}
            subtitle={t('settings.sessions.meta', { ip: s.ip || t('settings.sessions.unknownIp'), time: timeAgo(s.last_seen_at) })}
            end={
              s.current ? null : (
                <Button
                  label={t('settings.signOut')}
                  size="sm"
                  variant="secondary"
                  onPress={async () => {
                    setError(null);
                    try {
                      await (await client()).auth.revokeSession(s.id);
                      load();
                    } catch (e) {
                      setError(errorMessage(e));
                    }
                  }}
                />
              )
            }
          />
        ))
      )}
    </Card>
  );
}

/** A heading between groups of settings. */
export function SettingsHeading({ children }: { children: string }) {
  const c = useColors();
  return (
    <Text
      accessibilityRole="header"
      style={{ color: c.inkMuted, fontSize: 13, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: space[2] }}
    >
      {children}
    </Text>
  );
}
