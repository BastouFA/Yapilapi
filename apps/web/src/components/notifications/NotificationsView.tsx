'use client';

import { useState } from 'react';
import Link from 'next/link';
import type {
  NotificationCategory,
  NotificationChannel,
  NotificationItem,
} from '@yapilapi/api-client';
import {
  Avatar,
  BellIcon,
  Button,
  EmptyState,
  IconButton,
  CheckIcon,
  TrashIcon,
  Switch,
  FormField,
  Input,
  Select,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  cx,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, useInfinite, usePageTitle } from '@/lib/hooks';
import { useRealtimeEvents, useRealtime } from '@/lib/realtime';
import { describeError } from '@/lib/errors';
import { tKey } from '@/lib/dyn-key';
import { minutesToTime, timeToMinutes } from '@/lib/attention';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, InfiniteFooter, PageSpinner } from '@/components/common';
import { SettingsCard } from '@/components/settings/shared';

const CATEGORIES: NotificationCategory[] = [
  'messages',
  'friends',
  'creators',
  'communities',
  'events',
  'commerce',
  'security',
  'moderation',
  'system',
];
const CHANNELS: NotificationChannel[] = ['in_app', 'push', 'email'];

function targetHref(n: NotificationItem): string | null {
  switch (n.targetType) {
    case 'post':
    case 'comment':
      return n.targetId ? `/post/${encodeURIComponent(n.targetId)}` : null;
    case 'user':
      return n.actor ? `/u/${encodeURIComponent(n.actor.username)}` : null;
    case 'community':
      return n.targetId ? `/communities/${encodeURIComponent(n.targetId)}` : null;
    case 'event':
      return n.targetId ? `/events/${encodeURIComponent(n.targetId)}` : null;
    case 'business':
      return n.targetId ? `/businesses/${encodeURIComponent(n.targetId)}` : null;
    case 'booking':
      return `/businesses`;
    default:
      return null;
  }
}

function NotificationRow({
  n,
  onRead,
  onDelete,
}: {
  n: NotificationItem;
  onRead: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t, fmt } = useI18n();
  const key = `notifications.kind.${n.kind}`;
  const text = n.actor
    ? tKey(t, key, { name: n.actor.displayName })
    : (t as unknown as (k: string) => string)(key);
  const fallback = text === key ? t('notifications.kind.generic') : text;
  const href = targetHref(n);
  const body = (
    <div className="notif-row__text">
      <span>{fallback}</span>
      <span className="muted">{fmt.relative(n.createdAt)}</span>
    </div>
  );
  return (
    <li className={cx('notif-row', !n.read && 'is-unread')}>
      <Avatar
        name={n.actor?.displayName ?? t('app.name')}
        src={n.actor?.avatarUrl ?? null}
        size="md"
        decorative
      />
      {href ? (
        <Link href={href} className="notif-row__text" onClick={() => !n.read && onRead(n.id)}>
          {body}
        </Link>
      ) : (
        body
      )}
      <div className="notif-row__actions">
        {!n.read ? (
          <IconButton
            label={t('notifications.markRead')}
            icon={<CheckIcon size={16} />}
            size="sm"
            onClick={() => onRead(n.id)}
          />
        ) : null}
        <IconButton
          label={t('notifications.delete')}
          icon={<TrashIcon size={16} />}
          size="sm"
          onClick={() => onDelete(n.id)}
        />
      </div>
    </li>
  );
}

function NotificationsList() {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const { refreshNotifUnread } = useRealtime();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [category, setCategory] = useState<NotificationCategory | ''>('');

  const state = useInfinite<NotificationItem>(
    (cursor, signal) =>
      api.notifications
        .list({
          unread: unreadOnly || undefined,
          category: category || undefined,
          limit: 20,
          signal,
          ...(cursor ? { cursor } : {}),
        })
        .then((r) => r as { items: NotificationItem[]; nextCursor: string | null }),
    `${unreadOnly}::${category}`,
  );

  useRealtimeEvents((e) => {
    if (e.type === 'rt.notification') state.reload();
  });

  const markRead = async (id: string) => {
    state.setItems((prev) =>
      unreadOnly
        ? prev.filter((n) => n.id !== id)
        : prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
    );
    try {
      await api.notifications.markRead(id);
      refreshNotifUnread();
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    }
  };
  const remove = async (id: string) => {
    const before = state.items;
    state.setItems((prev) => prev.filter((n) => n.id !== id));
    try {
      await api.notifications.remove(id);
      toast.show({ tone: 'success', title: t('notifications.deleteDone') });
    } catch (e) {
      state.setItems(() => before);
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    }
  };
  const markAll = async () => {
    state.setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    try {
      await api.notifications.readAll(category || undefined);
      refreshNotifUnread();
      toast.show({ tone: 'success', title: t('notifications.markAllReadDone') });
    } catch (e) {
      state.reload();
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    }
  };

  return (
    <div className="stack">
      <div className="button-row button-row--between">
        <ul className="chips" aria-label={t('search.filterAll')}>
          <li>
            <button
              type="button"
              className={cx('chip', !unreadOnly && 'is-on')}
              aria-pressed={!unreadOnly}
              onClick={() => setUnreadOnly(false)}
            >
              {t('notifications.tab.all')}
            </button>
          </li>
          <li>
            <button
              type="button"
              className={cx('chip', unreadOnly && 'is-on')}
              aria-pressed={unreadOnly}
              onClick={() => setUnreadOnly(true)}
            >
              {t('notifications.tab.unread')}
            </button>
          </li>
        </ul>
        <Button variant="ghost" size="sm" onClick={() => void markAll()}>
          {t('notifications.markAllRead')}
        </Button>
      </div>
      <FormField id="notif-category" label={t('notifications.categoryFilter')} hideLabel>
        <Select
          value={category}
          onChange={(e) => setCategory(e.target.value as NotificationCategory | '')}
        >
          <option value="">{t('notifications.categoryAll')}</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`notifications.category.${c}`)}
            </option>
          ))}
        </Select>
      </FormField>

      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {!state.loading && !state.error && state.items.length === 0 ? (
        <EmptyState
          icon={<BellIcon size={28} />}
          title={t('notifications.emptyTitle')}
          description={unreadOnly ? t('notifications.emptyUnread') : t('notifications.emptyBody')}
        />
      ) : null}
      {state.items.length > 0 ? (
        <ul className="notif-list" aria-label={t('notifications.title')}>
          {state.items.map((n) => (
            <NotificationRow
              key={n.id}
              n={n}
              onRead={(id) => void markRead(id)}
              onDelete={(id) => void remove(id)}
            />
          ))}
        </ul>
      ) : null}
      <InfiniteFooter
        hasMore={state.hasMore}
        loading={state.loadingMore}
        error={state.moreError}
        onLoadMore={state.loadMore}
        onRetry={state.loadMore}
      />
    </div>
  );
}

function NotificationPreferences() {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const prefs = useAsync((signal) => api.notifications.getPreferences({ signal }), [api]);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const toggle = async (key: string, channel: NotificationChannel, enabled: boolean) => {
    setBusyKey(`${key}:${channel}`);
    try {
      const next = await api.notifications.setPreferences([{ key, channel, enabled }]);
      prefs.setData(next);
      toast.show({ tone: 'success', title: t('notifications.prefs.saved') });
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setBusyKey(null);
    }
  };

  const [quietOn, setQuietOn] = useState(false);
  const [start, setStart] = useState('22:00');
  const [end, setEnd] = useState('07:00');
  const [focusOn, setFocusOn] = useState(false);
  const [pause, setPause] = useState('');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  if (prefs.data && !hydrated) {
    const s = prefs.data.settings;
    setQuietOn(Boolean(s.quietHours));
    setStart(minutesToTime(s.quietHours?.start ?? 22 * 60));
    setEnd(minutesToTime(s.quietHours?.end ?? 7 * 60));
    setFocusOn(s.focusMode);
    setHydrated(true);
  }

  const saveSettings = async () => {
    setSettingsBusy(true);
    try {
      const s = timeToMinutes(start);
      const e = timeToMinutes(end);
      const next = await api.notifications.updateSettings({
        quietHours: quietOn && s !== null && e !== null && s !== e ? { start: s, end: e } : null,
        focusMode: focusOn,
        ...(pause ? { pauseForMinutes: Number(pause) } : {}),
      });
      prefs.setData((p) => (p ? { ...p, settings: next } : p));
      setPause('');
      toast.show({ tone: 'success', title: t('notifications.settingsSaved') });
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setSettingsBusy(false);
    }
  };
  const resumeNow = async () => {
    setSettingsBusy(true);
    try {
      const next = await api.notifications.updateSettings({ pauseForMinutes: null });
      prefs.setData((p) => (p ? { ...p, settings: next } : p));
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setSettingsBusy(false);
    }
  };

  if (prefs.loading) return <PageSpinner />;
  if (prefs.error) return <ErrorView error={prefs.error} onRetry={prefs.reload} />;
  if (!prefs.data) return null;

  return (
    <div className="stack">
      <SettingsCard
        id="notif-quiet"
        title={t('notifications.quiet.title')}
        description={t('notifications.quiet.lead')}
      >
        <Switch
          label={t('notifications.quiet.on')}
          checked={quietOn}
          onChange={(e) => setQuietOn(e.target.checked)}
        />
        {quietOn ? (
          <div className="inline-form">
            <FormField label={t('notifications.quiet.start')}>
              <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
            </FormField>
            <FormField label={t('notifications.quiet.end')}>
              <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
            </FormField>
          </div>
        ) : null}
        {prefs.data.settings.quietHours?.isDefault ? (
          <p className="muted">{t('notifications.quiet.teenLocked')}</p>
        ) : null}
      </SettingsCard>
      <SettingsCard
        id="notif-focus"
        title={t('notifications.focus.title')}
        description={t('notifications.focus.lead')}
      >
        <Switch
          label={t('notifications.focus.toggle')}
          checked={focusOn}
          onChange={(e) => setFocusOn(e.target.checked)}
        />
      </SettingsCard>
      <SettingsCard
        id="notif-pause"
        title={t('notifications.pause.title')}
        description={t('notifications.pause.lead')}
      >
        {prefs.data.settings.pausedUntil ? (
          <div className="button-row">
            <span>
              {t('notifications.pause.until', {
                when: new Date(prefs.data.settings.pausedUntil).toLocaleString(),
              })}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void resumeNow()}
              loading={settingsBusy}
            >
              {t('notifications.pause.resume')}
            </Button>
          </div>
        ) : (
          <FormField id="notif-pause-select" label={t('notifications.pause.title')} hideLabel>
            <Select value={pause} onChange={(e) => setPause(e.target.value)}>
              <option value="">{t('notifications.pause.off')}</option>
              <option value="60">{t('notifications.pause.for1h')}</option>
              <option value="480">{t('notifications.pause.for8h')}</option>
              <option value="1440">{t('notifications.pause.for1d')}</option>
            </Select>
          </FormField>
        )}
      </SettingsCard>
      <div className="button-row">
        <Button
          onClick={() => void saveSettings()}
          loading={settingsBusy}
          loadingLabel={t('common.saving')}
        >
          {t('common.save')}
        </Button>
      </div>

      <SettingsCard
        id="notif-channels"
        title={t('notifications.prefs.title')}
        description={t('notifications.prefs.lead')}
      >
        <p className="muted">{t('notifications.prefs.locked')}</p>
        <div className="stack">
          {prefs.data.categories.map((c) => (
            <div key={c.category} className="notif-row">
              <div className="notif-row__text">
                <strong>{t(`notifications.category.${c.category}`)}</strong>
                <div className="button-row">
                  {CHANNELS.map((ch) => {
                    const locked = ch === 'in_app' && c.inAppLocked;
                    return (
                      <Switch
                        key={ch}
                        label={t(`notifications.prefs.channel.${ch}`)}
                        checked={c.channels[ch].enabled}
                        disabled={locked || busyKey === `${c.category}:${ch}`}
                        onChange={(e) => void toggle(c.category, ch, e.target.checked)}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      </SettingsCard>
    </div>
  );
}

export function NotificationsView() {
  const { t } = useI18n();
  usePageTitle(t('notifications.title'), t('app.name'));
  return (
    <>
      <PageHeader title={t('notifications.title')} lead={t('notifications.lead')} />
      <Tabs defaultValue="inbox">
        <TabList label={t('notifications.title')}>
          <Tab value="inbox">{t('notifications.title')}</Tab>
          <Tab value="settings">{t('notifications.settings')}</Tab>
        </TabList>
        <TabPanel value="inbox">
          <NotificationsList />
        </TabPanel>
        <TabPanel value="settings">
          <NotificationPreferences />
        </TabPanel>
      </Tabs>
    </>
  );
}
