'use client';

import { useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, TextField } from '@yapilapi/design-system';
import type { AdminAnnouncement } from '@yapilapi/api-client';
import { ANNOUNCEMENT_BODY_MAX, ANNOUNCEMENT_TITLE_MAX, formatRelativeTime } from '@yapilapi/shared';
import { useSession } from '@/app/providers';
import { api, errorMessage } from '@/lib/api';
import { AnnouncementView } from '@/components/AnnouncementBanner';
import { formatCount, formatWhen, LoadFailed, Loading, useLoad } from './shared';

/** A link is https://… or a path in the app (/settings/privacy). The server checks it too. */
const linkOk = (v: string) => !v || /^\/(?![/\\])\S*$/.test(v) || /^https:\/\/[^\s/]+/i.test(v);

/** Write an announcement, see it as people will, publish it now or later, and end one early. */
export function Announcements() {
  const { t, tp, toast, locale } = useSession();
  const { data, error, reload } = useLoad(() => api.admin.announcements(), []);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [link, setLink] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [busy, setBusy] = useState(false);
  const badLink = !linkOk(link.trim());
  const ready = title.trim() && body.trim() && !badLink && !busy;
  const STATE: Record<AdminAnnouncement['state'], { label: string; tone: 'success' | 'neutral' | 'warning' }> = {
    active: { label: t('admin.announce.active'), tone: 'success' },
    scheduled: { label: t('admin.announce.scheduled'), tone: 'warning' },
    ended: { label: t('admin.announce.ended'), tone: 'neutral' },
  };
  return (
    <div className="stack">
      <Card title={t('admin.announce.write')} subtitle={t('admin.announce.writeSubtitle')}>
        <form
          className="stack-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!ready) return;
            setBusy(true);
            try {
              await api.admin.createAnnouncement({
                title: title.trim(),
                body: body.trim(),
                linkUrl: link.trim() || null,
                // The fields give a local date and time; the server takes a moment.
                ...(startsAt ? { startsAt: new Date(startsAt).toISOString() } : {}),
                ...(endsAt ? { endsAt: new Date(endsAt).toISOString() } : {}),
              });
              toast(startsAt && new Date(startsAt) > new Date() ? t('admin.announce.scheduledToast') : t('admin.announce.published'));
              setTitle('');
              setBody('');
              setLink('');
              setStartsAt('');
              setEndsAt('');
              reload();
            } catch (err) {
              toast(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <TextField
            label={t('admin.announce.title')}
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
            maxLength={ANNOUNCEMENT_TITLE_MAX}
            required
          />
          <TextField
            label={t('admin.announce.body')}
            multiline
            value={body}
            onChange={(e) => setBody(e.currentTarget.value)}
            maxLength={ANNOUNCEMENT_BODY_MAX}
            required
          />
          <TextField
            label={t('admin.announce.link')}
            hint={t('admin.announce.linkHint')}
            error={badLink ? t('admin.announce.linkBad') : undefined}
            value={link}
            onChange={(e) => setLink(e.currentTarget.value)}
            maxLength={2000}
            inputMode="url"
          />
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <TextField
              label={t('admin.announce.starts')}
              hint={t('admin.announce.startsHint')}
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.currentTarget.value)}
            />
            <TextField
              label={t('admin.announce.ends')}
              hint={t('admin.announce.endsHint')}
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.currentTarget.value)}
            />
          </div>
          <Alert tone="info">{t('admin.announce.asWritten')}</Alert>
          {title.trim() || body.trim() ? (
            <div className="stack-sm">
              <strong>{t('admin.announce.preview')}</strong>
              <AnnouncementView a={{ title: title.trim(), body: body.trim(), linkUrl: badLink ? null : link.trim() || null }} preview />
            </div>
          ) : null}
          <div className="row">
            <Button type="submit" disabled={!ready}>
              {t('admin.announce.publish')}
            </Button>
          </div>
        </form>
      </Card>
      {error ? (
        <LoadFailed error={error} onRetry={reload} />
      ) : !data ? (
        <Loading />
      ) : !data.items.length ? (
        <EmptyState title={t('admin.announce.none')} />
      ) : (
        <ul className="admin-list">
          {data.items.map((a) => (
            <li key={a.id} className="admin-list__item">
              <div className="row" style={{ alignItems: 'baseline' }}>
                <strong dir="auto">{a.title}</strong>
                <Badge tone={STATE[a.state].tone}>{STATE[a.state].label}</Badge>
              </div>
              <p className="admin-list__text" dir="auto">
                {a.body}
              </p>
              {a.linkUrl ? (
                <p className="muted" style={{ margin: 0, overflowWrap: 'anywhere' }}>
                  {a.linkUrl}
                </p>
              ) : null}
              <p className="muted" style={{ margin: 0 }}>
                {[
                  a.createdBy ? t('admin.announce.by', { username: a.createdBy }) : null,
                  a.state === 'scheduled' ? t('admin.announce.startsOn', { when: formatWhen(a.startsAt, locale) }) : formatRelativeTime(a.startsAt, locale),
                  a.endsAt ? t('admin.announce.endsOn', { when: formatWhen(a.endsAt, locale) }) : null,
                  tp('admin.announce.dismissals', a.dismissals, { count: formatCount(a.dismissals, locale) }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              {a.state !== 'ended' ? (
                <div className="row">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      try {
                        await api.admin.endAnnouncement(a.id);
                        toast(t('admin.announce.endedToast'));
                        reload();
                      } catch (e) {
                        toast(errorMessage(e));
                      }
                    }}
                  >
                    {a.state === 'scheduled' ? t('admin.announce.cancel') : t('admin.announce.end')}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
