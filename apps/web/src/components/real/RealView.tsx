'use client';

import { useState } from 'react';
import type { RealCapture, RealReactionKind, RealVisibility } from '@yapilapi/api-client';
import {
  Badge,
  Button,
  CameraIcon,
  Card,
  EmptyState,
  FeedTabs,
  FormField,
  Input,
  Select,
  Switch,
  Textarea,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, usePageTitle } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { PageHeader } from '@/components/PageHeader';
import { ConfirmDialog, ErrorView, PageSpinner } from '@/components/common';

type Tab = 'tray' | 'mine' | 'reminders';
const REACTIONS: RealReactionKind[] = ['like', 'love', 'laugh', 'wow', 'sad', 'insightful'];
const REACTION_KEYS = {
  like: 'real.reaction.like',
  love: 'real.reaction.love',
  laugh: 'real.reaction.laugh',
  wow: 'real.reaction.wow',
  sad: 'real.reaction.sad',
  insightful: 'real.reaction.insightful',
} as const satisfies Record<RealReactionKind, string>;
const DAY_KEYS = [
  'real.reminders.day.0',
  'real.reminders.day.1',
  'real.reminders.day.2',
  'real.reminders.day.3',
  'real.reminders.day.4',
  'real.reminders.day.5',
  'real.reminders.day.6',
] as const;

/** A per-browser device id for capture sessions (a convenience identifier, not shared or security-critical). */
function deviceId(): string {
  try {
    const k = 'yl-real-device-id';
    let v = window.localStorage.getItem(k);
    if (!v) {
      v = `web-${crypto.randomUUID()}`;
      window.localStorage.setItem(k, v);
    }
    return v;
  } catch {
    return `web-${Math.random().toString(36).slice(2)}${Date.now()}`;
  }
}

function fail(toast: ReturnType<typeof useToast>, t: ReturnType<typeof useI18n>['t'], e: unknown) {
  toast.show({
    tone: 'danger',
    title: t('error.actionFailed'),
    description: describeError(e, t).message,
  });
}

// ------------------------------------------------------------------ capture card
function CaptureCard({
  c,
  mine,
  onReacted,
  onShared,
  onDeleted,
}: {
  c: RealCapture;
  mine: boolean;
  onReacted: (c: RealCapture) => void;
  onShared: () => void;
  onDeleted: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [sharing, setSharing] = useState(false);
  const [shareVisibility, setShareVisibility] = useState<
    'public' | 'followers' | 'friends' | 'circle' | 'selected' | 'private'
  >('friends');
  const [shareInclude, setShareInclude] = useState<'both' | 'front' | 'rear'>('both');
  const [shareLocation, setShareLocation] = useState(false);
  const [shareBody, setShareBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const react = async (kind: RealReactionKind) => {
    try {
      if (c.viewer.reaction === kind) {
        await api.real.removeReaction(c.id);
        onReacted({
          ...c,
          viewer: { ...c.viewer, reaction: null },
          reactionCount: c.reactionCount - 1,
        });
      } else {
        const already = c.viewer.reaction !== null;
        const r = await api.real.react(c.id, kind);
        onReacted({
          ...c,
          viewer: { ...c.viewer, reaction: kind },
          reactionCount: already ? r.reactionCount : r.reactionCount,
        });
      }
    } catch (e) {
      fail(toast, t, e);
    }
  };

  const submitShare = async () => {
    setBusy(true);
    try {
      await api.real.share(c.id, {
        visibility: shareVisibility,
        include: shareInclude,
        includeLocation: shareLocation,
        body: shareBody.trim() || undefined,
      });
      toast.show({ tone: 'success', title: t('real.shared') });
      setSharing(false);
      onShared();
    } catch (e) {
      fail(toast, t, e);
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    setBusy(true);
    try {
      await api.real.remove(c.id);
      toast.show({ tone: 'success', title: t('real.deleted') });
      setDeleteOpen(false);
      onDeleted();
    } catch (e) {
      fail(toast, t, e);
      setDeleteOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md" className="stack-sm" data-testid="real-capture">
      <div className="entity-card__meta">
        <strong>{c.author.displayName}</strong>
        <span className="muted">@{c.author.username}</span>
      </div>
      <div className="button-row">
        {c.front?.url ? (
          <img src={c.front.url} alt="" width={96} height={96} style={{ borderRadius: 8 }} />
        ) : null}
        {c.rear?.url ? (
          <img src={c.rear.url} alt="" width={96} height={96} style={{ borderRadius: 8 }} />
        ) : null}
      </div>
      {c.caption ? <p>{c.caption}</p> : null}
      <div className="button-row">
        {c.indicators.map((i) => (
          <Badge key={i.key} tone={i.ok ? 'success' : 'neutral'}>
            {i.label}
          </Badge>
        ))}
      </div>
      <div className="button-row">
        {REACTIONS.map((k) => (
          <Button
            key={k}
            size="sm"
            variant={c.viewer.reaction === k ? 'secondary' : 'ghost'}
            onClick={() => void react(k)}
          >
            {t(REACTION_KEYS[k])}
          </Button>
        ))}
        <span className="muted">{t('real.reactionCount', { count: c.reactionCount })}</span>
      </div>
      {mine ? (
        <div className="button-row">
          {!c.sharedPostId ? (
            <Button size="sm" variant="secondary" onClick={() => setSharing((v) => !v)}>
              {t('real.share')}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setDeleteOpen(true)}>
            {t('real.delete')}
          </Button>
        </div>
      ) : null}
      {sharing ? (
        <div className="stack-sm">
          <FormField label={t('real.form.visibility')}>
            <Select
              value={shareVisibility}
              onChange={(e) => setShareVisibility(e.target.value as typeof shareVisibility)}
            >
              <option value="public">{t('real.form.visibility.public')}</option>
              <option value="followers">{t('real.form.visibility.followers')}</option>
              <option value="friends">{t('real.form.visibility.friends')}</option>
              <option value="selected">{t('real.form.visibility.selected')}</option>
              <option value="private">{t('real.form.visibility.private')}</option>
            </Select>
          </FormField>
          <FormField label={t('real.share.include')}>
            <Select
              value={shareInclude}
              onChange={(e) => setShareInclude(e.target.value as typeof shareInclude)}
            >
              <option value="both">{t('real.share.include.both')}</option>
              <option value="front">{t('real.share.include.front')}</option>
              <option value="rear">{t('real.share.include.rear')}</option>
            </Select>
          </FormField>
          <Switch
            label={t('real.share.includeLocation')}
            checked={shareLocation}
            onChange={(e) => setShareLocation(e.target.checked)}
          />
          <FormField label={t('real.share.body')}>
            <Textarea value={shareBody} onChange={(e) => setShareBody(e.target.value)} rows={2} />
          </FormField>
          <Button size="sm" loading={busy} onClick={() => void submitShare()}>
            {t('real.share.submit')}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={deleteOpen}
        title={t('real.deleteConfirm.title')}
        description={t('real.deleteConfirm.body')}
        confirmLabel={t('real.delete')}
        danger
        busy={busy}
        onConfirm={() => void del()}
        onClose={() => setDeleteOpen(false)}
      />
    </Card>
  );
}

// ------------------------------------------------------------------ tray
function TrayPanel() {
  const { t, fmt } = useI18n();
  const api = useApi();
  const state = useAsync((signal) => api.real.tray({ signal }), [api]);
  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  const groups = state.data?.items ?? [];
  if (groups.length === 0)
    return <EmptyState icon={<CameraIcon size={28} />} title={t('real.tray.empty')} />;
  return (
    <div className="stack">
      {groups.map((g) => (
        <Card key={g.author.id} padding="md" className="stack-sm">
          <div className="entity-card__meta">
            <strong>{g.author.displayName}</strong>
            <span className="muted">{t('real.tray.count', { count: g.count })}</span>
            <span className="muted">{fmt.relative(g.latestAt)}</span>
          </div>
          <ul className="stack-sm">
            {g.items.map((c) => (
              <li key={c.id} className="search-row">
                <span className="search-row__text">
                  <span>{c.caption || t('real.title')}</span>
                  <span className="muted">{fmt.relative(c.capturedAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ new capture
function NewCaptureForm({ onCreated }: { onCreated: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [front, setFront] = useState<File | null>(null);
  const [rear, setRear] = useState<File | null>(null);
  const [caption, setCaption] = useState('');
  const [visibility, setVisibility] = useState<RealVisibility>('friends');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!front && !rear) {
      setError(t('real.needsPhoto'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      const dev = deviceId();
      const session = await api.real.startCaptureSession({ deviceId: dev, clientTime: Date.now() });
      const [frontMedia, rearMedia] = await Promise.all([
        front ? api.media.upload(front, { purpose: 'attachment' }) : Promise.resolve(null),
        rear ? api.media.upload(rear, { purpose: 'attachment' }) : Promise.resolve(null),
      ]);
      await api.real.createCapture({
        captureToken: session.token,
        deviceId: dev,
        frontMediaId: frontMedia?.id,
        rearMediaId: rearMedia?.id,
        caption: caption.trim(),
        capturedAt: new Date().toISOString(),
        visibility,
      });
      toast.show({ tone: 'success', title: t('real.created') });
      setFront(null);
      setRear(null);
      setCaption('');
      onCreated();
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md" className="stack-sm">
      <h3 className="section-title">{t('real.new')}</h3>
      <FormField label={t('real.form.front')}>
        <Input
          type="file"
          accept="image/*"
          onChange={(e) => setFront(e.target.files?.[0] ?? null)}
        />
      </FormField>
      <FormField label={t('real.form.rear')}>
        <Input
          type="file"
          accept="image/*"
          onChange={(e) => setRear(e.target.files?.[0] ?? null)}
        />
      </FormField>
      <FormField label={t('real.form.caption')}>
        <Textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={2} />
      </FormField>
      <FormField label={t('real.form.visibility')}>
        <Select
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as RealVisibility)}
        >
          <option value="public">{t('real.form.visibility.public')}</option>
          <option value="followers">{t('real.form.visibility.followers')}</option>
          <option value="friends">{t('real.form.visibility.friends')}</option>
          <option value="selected">{t('real.form.visibility.selected')}</option>
          <option value="private">{t('real.form.visibility.private')}</option>
        </Select>
      </FormField>
      {error ? (
        <p className="yl-notice yl-notice--danger" role="alert">
          {error}
        </p>
      ) : null}
      <Button loading={busy} onClick={() => void submit()}>
        {t('real.form.submit')}
      </Button>
    </Card>
  );
}

// ------------------------------------------------------------------ mine
function MinePanel() {
  const api = useApi();
  const { t } = useI18n();
  const state = useAsync((signal) => api.real.mine({ signal }), [api]);
  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  const items = state.data?.items ?? [];
  return (
    <div className="stack">
      <NewCaptureForm onCreated={state.reload} />
      {items.length === 0 ? (
        <p className="muted">{t('real.mine.empty')}</p>
      ) : (
        <ul className="stack-sm">
          {items.map((c) => (
            <li key={c.id}>
              <CaptureCard
                c={c}
                mine
                onReacted={(nc) =>
                  state.setData((d) =>
                    d ? { ...d, items: d.items.map((x) => (x.id === nc.id ? nc : x)) } : d,
                  )
                }
                onShared={state.reload}
                onDeleted={state.reload}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ reminders
function RemindersPanel() {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const state = useAsync((signal) => api.real.reminders({ signal }), [api]);
  const [enabled, setEnabled] = useState(false);
  const [days, setDays] = useState<number[]>([]);
  const [localMinute, setLocalMinute] = useState(18 * 60);
  const [busy, setBusy] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);

  if (state.data && !loadedOnce) {
    setEnabled(state.data.enabled);
    setDays(state.data.days);
    setLocalMinute(state.data.localMinute);
    setLoadedOnce(true);
  }

  const toggleDay = (d: number) =>
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));

  const save = async () => {
    setBusy(true);
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      await api.real.setReminders({ enabled, days, localMinute, timezone: tz });
      toast.show({ tone: 'success', title: t('real.reminders.saved') });
    } catch (e) {
      fail(toast, t, e);
    } finally {
      setBusy(false);
    }
  };

  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;

  const hh = String(Math.floor(localMinute / 60)).padStart(2, '0');
  const mm = String(localMinute % 60).padStart(2, '0');

  return (
    <Card padding="md" className="stack-sm">
      <p className="muted">{t('real.reminders.lead')}</p>
      <Switch
        label={t('real.reminders.enabled')}
        checked={enabled}
        onChange={(e) => setEnabled(e.target.checked)}
      />
      <FormField label={t('real.reminders.days')}>
        <div className="button-row">
          {DAY_KEYS.map((k, d) => (
            <Button
              key={d}
              size="sm"
              variant={days.includes(d) ? 'secondary' : 'ghost'}
              onClick={() => toggleDay(d)}
            >
              {t(k)}
            </Button>
          ))}
        </div>
      </FormField>
      <FormField label={t('real.reminders.time')}>
        <Input
          type="time"
          value={`${hh}:${mm}`}
          onChange={(e) => {
            const [h, m] = e.target.value.split(':').map(Number);
            if (h !== undefined && m !== undefined) setLocalMinute(h * 60 + m);
          }}
        />
      </FormField>
      <Button loading={busy} onClick={() => void save()}>
        {t('real.reminders.save')}
      </Button>
    </Card>
  );
}

// ------------------------------------------------------------------ shell
export function RealView() {
  const { t } = useI18n();
  usePageTitle(t('real.title'), t('app.name'));
  const [tab, setTab] = useState<Tab>('tray');

  return (
    <>
      <PageHeader title={t('real.title')} lead={t('real.lead')} />
      <FeedTabs
        label={t('real.title')}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        tabs={[
          { id: 'tray', label: t('real.tab.tray') },
          { id: 'mine', label: t('real.tab.mine') },
          { id: 'reminders', label: t('real.tab.reminders') },
        ]}
      >
        {tab === 'tray' ? <TrayPanel key="tray" /> : null}
        {tab === 'mine' ? <MinePanel key="mine" /> : null}
        {tab === 'reminders' ? <RemindersPanel key="reminders" /> : null}
      </FeedTabs>
    </>
  );
}
