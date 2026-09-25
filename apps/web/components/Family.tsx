'use client';

import { useEffect, useState } from 'react';
import { Alert, Avatar, Badge, Button, Card, List, ListItem, Select, TextField } from '@yapilapi/design-system';
import type { FamilyLink, TeenControls } from '@yapilapi/api-client';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

const LIMITS = [null, 30, 60, 90, 120, 180];

/**
 * Family supervision. Guardians invite a teen by username; the teen accepts.
 * Guardians set who the teen can message, a daily reminder and quiet hours,
 * and see daily minutes. They never see messages or activity.
 */
export function FamilyCard() {
  const { toast } = useSession();
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
    <Card title="Family" subtitle="Supervise a teen's account together. Guardians never see messages, posts in private spaces or searches.">
      <div className="stack">
        {items.length ? (
          <List>
            {items.map((l) => {
              const other = l.role === 'guardian' ? l.teen : l.guardian;
              return (
                <ListItem
                  key={l.id}
                  start={<Avatar name={other?.displayName ?? '?'} src={other?.avatarUrl ?? null} size="sm" />}
                  primary={other?.displayName ?? 'Account'}
                  secondary={
                    l.status === 'pending'
                      ? l.role === 'teen'
                        ? 'Wants to supervise your account'
                        : 'Invitation sent'
                      : l.role === 'guardian'
                        ? 'You supervise this account'
                        : 'Supervises your account'
                  }
                  end={
                    <>
                      {l.status === 'pending' && l.role === 'teen' ? (
                        <Button size="sm" onClick={() => act(() => api.family.accept(l.id), 'Family link accepted')}>
                          Accept
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => act(() => api.family.end(l.id), l.status === 'pending' ? 'Declined' : 'Family link ended')}
                      >
                        {l.status === 'pending' && l.role === 'teen' ? 'Decline' : l.status === 'pending' ? 'Cancel' : 'End'}
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
              <Alert key={l.id} tone="info" title={`${l.guardian?.displayName ?? 'Your guardian'} set these for you`}>
                {describe(l.controls!)}
              </Alert>
            ),
          )}

        <form
          className="row"
          style={{ alignItems: 'flex-end' }}
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api.family.invite(username.trim().replace(/^@/, '')), 'Invitation sent. They need to accept it.').then(() => setUsername(''));
          }}
        >
          <div style={{ flex: 1, minWidth: 200 }}>
            <TextField
              label="Supervise a teen (their username)"
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              placeholder="@username"
            />
          </div>
          <Button type="submit" variant="secondary" disabled={!username.trim()}>
            Invite
          </Button>
        </form>
      </div>
    </Card>
  );
}

function describe(c: TeenControls): string {
  const parts = [c.messagesFrom === 'nobody' ? 'Only family can message you.' : 'Only friends and family can message you.'];
  if (c.dailyLimitMinutes) parts.push(`A reminder after ${c.dailyLimitMinutes} minutes a day.`);
  if (c.quietStart && c.quietEnd) parts.push(`Quiet hours ${c.quietStart} to ${c.quietEnd} (${c.timezone}): notifications wait until morning.`);
  return parts.join(' ');
}

function GuardianControls({ link, onSaved }: { link: FamilyLink; onSaved: () => void }) {
  const { toast } = useSession();
  const [c, setC] = useState<TeenControls>(link.controls!);
  const [saving, setSaving] = useState(false);
  const week = link.usage ?? [];
  const max = Math.max(60, ...week.map((d) => d.minutes));
  return (
    <div className="family-controls">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{link.teen?.displayName}</strong>
        <Badge tone="success">Supervised</Badge>
      </div>
      {week.length ? (
        <div className="usage" aria-label="Minutes per day, last 7 days">
          {week.map((d) => (
            <div key={d.day} className="usage__day" title={`${d.minutes} min`}>
              <span className="usage__bar" style={{ height: `${Math.max(4, (d.minutes / max) * 64)}px` }} />
              <span className="usage__label">{new Date(d.day).toLocaleDateString(undefined, { weekday: 'narrow' })}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          No time recorded this week yet.
        </p>
      )}
      <Select
        label="Who can message them"
        value={c.messagesFrom}
        onChange={(e) => setC({ ...c, messagesFrom: e.currentTarget.value as TeenControls['messagesFrom'] })}
      >
        <option value="friends">Friends and family</option>
        <option value="nobody">Family only</option>
      </Select>
      <Select
        label="Daily reminder"
        value={String(c.dailyLimitMinutes ?? '')}
        onChange={(e) => setC({ ...c, dailyLimitMinutes: e.currentTarget.value ? Number(e.currentTarget.value) : null })}
      >
        {LIMITS.map((m) => (
          <option key={String(m)} value={m ?? ''}>
            {m ? `After ${m >= 60 ? `${m / 60} hour${m > 60 ? 's' : ''}` : `${m} minutes`}` : 'Off'}
          </option>
        ))}
      </Select>
      <div className="row">
        <TextField label="Quiet from" type="time" value={c.quietStart ?? ''} onChange={(e) => setC({ ...c, quietStart: e.currentTarget.value || null })} />
        <TextField label="Until" type="time" value={c.quietEnd ?? ''} onChange={(e) => setC({ ...c, quietEnd: e.currentTarget.value || null })} />
      </div>
      <Button
        size="sm"
        loading={saving}
        onClick={async () => {
          setSaving(true);
          try {
            await api.family.setControls(link.id, { ...c, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
            toast(`Saved. ${link.teen?.displayName ?? 'They'} will be told.`);
            onSaved();
          } catch (e) {
            toast(errorMessage(e));
          } finally {
            setSaving(false);
          }
        }}
      >
        Save settings
      </Button>
    </div>
  );
}
