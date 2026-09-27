'use client';

import { useEffect, useState } from 'react';
import { Alert, Avatar, Badge, Button, Card, List, ListItem, Select, TextField } from '@yapilapi/design-system';
import type { FamilyLink, TeenControls } from '@yapilapi/api-client';
import type { MessageKey } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

const LIMITS = [null, 30, 60, 90, 120, 180];

/**
 * Family supervision. Guardians invite a teen by username; the teen accepts.
 * Guardians set who the teen can message, a daily reminder and quiet hours,
 * and see daily minutes. They never see messages or activity.
 */
export function FamilyCard() {
  const { toast, t } = useSession();
  const [items, setItems] = useState<FamilyLink[] | null>(null);
  const [username, setUsername] = useState('');
  const load = () =>
    api.family.list().then(
      (r) => setItems(r.items),
      () => setItems([]),
    );
  useEffect(() => {
    void load();
  }, []);
  if (!items) return null;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast(done);
      await load();
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  return (
    <Card title={t('m.family.title')} subtitle={t('m.family.body')}>
      <div className="stack">
        {items.length ? (
          <List>
            {items.map((l) => {
              const other = l.role === 'guardian' ? l.teen : l.guardian;
              return (
                <ListItem
                  key={l.id}
                  start={<Avatar name={other?.displayName ?? '?'} src={other?.avatarUrl ?? null} size="sm" />}
                  primary={other?.displayName ?? t('m.family.account')}
                  secondary={
                    l.status === 'pending'
                      ? l.role === 'teen'
                        ? t('m.family.status.wants')
                        : t('m.family.status.invited')
                      : l.role === 'guardian'
                        ? t('m.family.status.guardian')
                        : t('m.family.status.teen')
                  }
                  end={
                    <>
                      {l.status === 'pending' && l.role === 'teen' ? (
                        <Button size="sm" onClick={() => act(() => api.family.accept(l.id), t('family.accepted'))}>
                          {t('m.common.accept')}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => act(() => api.family.end(l.id), l.status === 'pending' ? t('family.declined') : t('family.ended'))}
                      >
                        {l.status === 'pending' && l.role === 'teen' ? t('m.common.decline') : l.status === 'pending' ? t('common.cancel') : t('m.family.end')}
                      </Button>
                    </>
                  }
                />
              );
            })}
          </List>
        ) : null}

        {items
          .filter((l) => l.status === 'active' && l.controls)
          .map((l) =>
            l.role === 'guardian' ? (
              <GuardianControls key={l.id} link={l} onSaved={load} />
            ) : (
              <Alert key={l.id} tone="info" title={t('m.family.setForYou', { name: l.guardian?.displayName ?? t('m.family.yourGuardian') })}>
                {describe(l.controls!, t)}
              </Alert>
            ),
          )}

        <form
          className="row"
          style={{ alignItems: 'flex-end' }}
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api.family.invite(username.trim().replace(/^@/, '')), t('m.family.invite.sent')).then(() => setUsername(''));
          }}
        >
          <div style={{ flex: 1, minWidth: 200 }}>
            <TextField
              label={t('m.family.invite.label')}
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              placeholder={t('m.family.invite.placeholder')}
            />
          </div>
          <Button type="submit" variant="secondary" disabled={!username.trim()}>
            {t('m.family.invite')}
          </Button>
        </form>
      </div>
    </Card>
  );
}

function describe(c: TeenControls, t: (key: MessageKey, vars?: Record<string, string | number>) => string): string {
  const parts = [c.messagesFrom === 'nobody' ? t('m.family.rule.familyOnly') : t('m.family.rule.friends')];
  if (c.dailyLimitMinutes) parts.push(t('m.family.rule.limit', { minutes: c.dailyLimitMinutes }));
  if (c.quietStart && c.quietEnd) parts.push(t('m.family.rule.quiet', { start: c.quietStart, end: c.quietEnd, timezone: c.timezone }));
  return parts.join(' ');
}

function GuardianControls({ link, onSaved }: { link: FamilyLink; onSaved: () => void }) {
  const { toast, t, tp, locale } = useSession();
  const [c, setC] = useState<TeenControls>(link.controls!);
  const [saving, setSaving] = useState(false);
  const week = link.usage ?? [];
  const max = Math.max(60, ...week.map((d) => d.minutes));
  return (
    <div className="family-controls">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{link.teen?.displayName}</strong>
        <Badge tone="success">{t('family.supervised')}</Badge>
      </div>
      {week.length ? (
        <div className="usage" aria-label={t('family.week')}>
          {week.map((d) => (
            <div key={d.day} className="usage__day" title={t('m.unit.minutes', { count: d.minutes })}>
              <span className="usage__bar" style={{ height: `${Math.max(4, (d.minutes / max) * 64)}px` }} />
              <span className="usage__label">{new Date(d.day).toLocaleDateString(locale, { weekday: 'narrow' })}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          {t('m.family.noUsage')}
        </p>
      )}
      <Select
        label={t('m.family.whoCanMessage')}
        value={c.messagesFrom}
        onChange={(e) => setC({ ...c, messagesFrom: e.currentTarget.value as TeenControls['messagesFrom'] })}
      >
        <option value="friends">{t('m.family.friendsAndFamily')}</option>
        <option value="nobody">{t('m.family.familyOnly')}</option>
      </Select>
      <Select
        label={t('m.family.dailyReminder')}
        value={String(c.dailyLimitMinutes ?? '')}
        onChange={(e) => setC({ ...c, dailyLimitMinutes: e.currentTarget.value ? Number(e.currentTarget.value) : null })}
      >
        {LIMITS.map((m) => (
          <option key={String(m)} value={m ?? ''}>
            {m ? (m >= 60 ? tp('family.limit.hours', m / 60, { hours: m / 60 }) : t('family.limit.minutes', { count: m })) : t('m.family.limit.off')}
          </option>
        ))}
      </Select>
      <div className="row">
        <TextField
          label={t('m.family.quietFrom')}
          type="time"
          value={c.quietStart ?? ''}
          onChange={(e) => setC({ ...c, quietStart: e.currentTarget.value || null })}
        />
        <TextField label={t('m.family.until')} type="time" value={c.quietEnd ?? ''} onChange={(e) => setC({ ...c, quietEnd: e.currentTarget.value || null })} />
      </div>
      <Button
        size="sm"
        loading={saving}
        onClick={async () => {
          setSaving(true);
          try {
            await api.family.setControls(link.id, { ...c, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
            toast(link.teen?.displayName ? t('m.family.savedTold', { name: link.teen.displayName }) : t('m.family.savedToldThem'));
            onSaved();
          } catch (e) {
            toast(errorMessage(e));
          } finally {
            setSaving(false);
          }
        }}
      >
        {t('m.family.save')}
      </Button>
    </div>
  );
}
