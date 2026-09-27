'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Avatar, Button, Card, Dialog, EmptyState, Select, Skeleton, TextField } from '@yapilapi/design-system';
import type { Circle, CircleKind, MessageKey, PublicUser } from '@yapilapi/shared';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { useSession } from '@/app/providers';

/** Kinds offered when making a circle. ('close_friends' stays for older circles: close friends is its own list now.) */
export const CIRCLE_KIND_LABELS: Partial<Record<CircleKind, MessageKey>> = {
  custom: 'm.circles.kind.custom',
  family: 'm.circles.kind.family',
  work: 'm.circles.kind.work',
  business: 'm.circles.kind.business',
  travel: 'm.circles.kind.travel',
};

/**
 * Circles: small groups you share posts with, like Family or Work. Only you see
 * them. People aren't told when you add or remove them, and never see which
 * circles they're in.
 */
export function CirclesManager({ initialId }: { initialId?: string | null }) {
  const { toast, t, tp } = useSession();
  const [circles, setCircles] = useState<Circle[] | null>(null);
  const [selected, setSelected] = useState<string | null>(initialId ?? null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CircleKind>('custom');
  const [error, setError] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.circles.list().then(
      (r) => setCircles(r.items),
      (e) => {
        setCircles([]);
        toast(errorMessage(e));
      },
    );
  }, [toast]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError(t('circles.nameRequired'));
    setCreating(true);
    setError(undefined);
    try {
      const { circle } = await api.circles.create({ name: name.trim(), kind });
      setCircles((cur) => [...(cur ?? []), circle]);
      setSelected(circle.id);
      setName('');
      setKind('custom');
      toast(t('circles.created', { name: circle.name }));
    } catch (err) {
      setError(fieldErrors(err).name ?? errorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  const replace = (c: Circle) => setCircles((cur) => (cur ?? []).map((x) => (x.id === c.id ? c : x)));
  const current = circles?.find((c) => c.id === selected) ?? null;

  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        {t('circles.intro')}
      </p>
      <Card title={t('m.circles.new')} level={2}>
        <form className="stack" onSubmit={create}>
          <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <TextField
              label={t('m.circles.name')}
              placeholder={t('m.circles.kind.family')}
              value={name}
              maxLength={40}
              error={error}
              onChange={(e) => setName(e.currentTarget.value)}
              className="circles-form__name"
            />
            <Select label={t('circles.kind')} value={kind} onChange={(e) => setKind(e.currentTarget.value as CircleKind)}>
              {Object.entries(CIRCLE_KIND_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {t(label)}
                </option>
              ))}
            </Select>
            <Button type="submit" icon="plus" loading={creating}>
              {t('m.chapters.create')}
            </Button>
          </div>
        </form>
      </Card>

      {circles === null ? (
        <Skeleton height={120} />
      ) : circles.length ? (
        <ul className="circles__list" aria-label={t('m.circles.yours')}>
          {circles.map((c) => (
            <li key={c.id} className="circles__row" aria-current={c.id === selected ? 'true' : undefined}>
              <span className="sound-row__text">
                <bdi className="sound-row__title">{c.name}</bdi>
                <span className="sound-row__meta">
                  {t(CIRCLE_KIND_LABELS[c.kind] ?? 'm.circles.kind.custom')} · {tp('m.circles.members', c.memberCount)}
                </span>
              </span>
              <Button size="sm" variant={c.id === selected ? 'primary' : 'secondary'} onClick={() => setSelected(c.id === selected ? null : c.id)}>
                {c.id === selected ? t('m.common.close') : t('circles.manage')}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={t('circles.emptyTitle')} body={t('circles.emptyBody')} />
      )}

      {current ? (
        <CircleDetail
          key={current.id}
          circle={current}
          onChange={replace}
          onDeleted={() => {
            setCircles((cur) => (cur ?? []).filter((x) => x.id !== current.id));
            setSelected(null);
          }}
        />
      ) : null}
    </div>
  );
}

function CircleDetail({ circle, onChange, onDeleted }: { circle: Circle; onChange: (c: Circle) => void; onDeleted: () => void }) {
  const { toast, t, tp } = useSession();
  const id = useId();
  const [members, setMembers] = useState<PublicUser[] | null>(null);
  const [q, setQ] = useState('');
  const [suggestions, setSuggestions] = useState<PublicUser[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(circle.name);
  const [renameError, setRenameError] = useState<string | undefined>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const req = useRef(0);

  useEffect(() => {
    api.circles.members(circle.id).then(
      (r) => setMembers(r.items),
      (e) => {
        setMembers([]);
        toast(errorMessage(e));
      },
    );
  }, [circle.id, toast]);

  // With nothing typed: friends, people you follow and recent chats. As you type: matches, friends first.
  useEffect(() => {
    const n = ++req.current;
    const timer = setTimeout(
      () =>
        api.people.suggest(q.trim(), 12).then(
          (r) => n === req.current && setSuggestions(r.items.map((x) => x.user)),
          () => {},
        ),
      q ? 150 : 0,
    );
    return () => clearTimeout(timer);
  }, [q]);

  async function add(u: PublicUser) {
    setBusy(u.id);
    try {
      const r = await api.circles.addMembers(circle.id, [u.id]);
      if (r.added) setMembers((cur) => [u, ...(cur ?? []).filter((x) => x.id !== u.id)]);
      else toast(t('circles.cantAdd', { name: u.displayName }));
      onChange(r.circle);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(u: PublicUser) {
    setBusy(u.id);
    try {
      const r = await api.circles.removeMember(circle.id, u.id);
      setMembers((cur) => (cur ?? []).filter((x) => x.id !== u.id));
      onChange(r.circle);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function rename(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return setRenameError(t('circles.nameRequired'));
    setBusy('rename');
    try {
      const { circle: c } = await api.circles.update(circle.id, { name: newName.trim() });
      onChange(c);
      setRenaming(false);
      setRenameError(undefined);
      toast(t('circles.renamed'));
    } catch (err) {
      setRenameError(fieldErrors(err).name ?? errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function destroy() {
    setBusy('delete');
    try {
      await api.circles.remove(circle.id);
      toast(t('circles.deleted', { name: circle.name }));
      onDeleted();
    } catch (e) {
      toast(errorMessage(e));
      setBusy(null);
    }
  }

  const inCircle = new Set((members ?? []).map((m) => m.id));
  const addable = suggestions.filter((u) => !inCircle.has(u.id));

  return (
    <Card
      level={2}
      title={<bdi>{circle.name}</bdi>}
      subtitle={tp('m.circles.members', circle.memberCount)}
      action={
        <div className="row">
          <Button size="sm" variant="ghost" onClick={() => setRenaming((r) => !r)}>
            {t('circles.rename')}
          </Button>
          <Button size="sm" variant="ghost" icon="trash" onClick={() => setConfirmDelete(true)}>
            {t('m.common.delete')}
          </Button>
        </div>
      }
    >
      <div className="stack">
        {renaming ? (
          <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={rename}>
            <TextField
              label={t('circles.newName')}
              value={newName}
              maxLength={40}
              error={renameError}
              onChange={(e) => setNewName(e.currentTarget.value)}
              className="circles-form__name"
            />
            <Button type="submit" size="sm" loading={busy === 'rename'}>
              {t('common.save')}
            </Button>
          </form>
        ) : null}

        <h3 className="yp-field__label" style={{ margin: 0 }}>
          {t('m.circles.inCircle')}
        </h3>
        {members === null ? (
          <p className="muted">{t('common.loading')}</p>
        ) : members.length ? (
          <ul className="close-friends__list">
            {members.map((u) => (
              <li key={u.id} className="close-friends__row">
                <Avatar name={u.displayName} src={u.avatarUrl} size="sm" />
                <span className="sound-row__text">
                  <bdi className="sound-row__title">{u.displayName}</bdi>
                  <span className="sound-row__meta">
                    <bdi>@{u.username}</bdi>
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === u.id}
                  onClick={() => remove(u)}
                  aria-label={t('circles.removeMember', { name: u.displayName, circle: circle.name })}
                >
                  {t('m.common.remove')}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            {t('m.circles.noMembers')}
          </p>
        )}

        <label htmlFor={`${id}-q`} className="yp-field__label">
          {t('m.circles.addHeading')}
        </label>
        <input
          id={`${id}-q`}
          className="yp-input"
          type="search"
          autoComplete="off"
          placeholder={t('m.closeFriends.search')}
          value={q}
          maxLength={60}
          onChange={(e) => setQ(e.currentTarget.value)}
        />
        {addable.length ? (
          <ul className="close-friends__list" aria-label={t('circles.addable')}>
            {addable.map((u) => (
              <li key={u.id} className="close-friends__row">
                <Avatar name={u.displayName} src={u.avatarUrl} size="sm" />
                <span className="sound-row__text">
                  <bdi className="sound-row__title">{u.displayName}</bdi>
                  <span className="sound-row__meta">
                    <bdi>@{u.username}</bdi>
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === u.id}
                  onClick={() => add(u)}
                  aria-label={t('circles.addMember', { name: u.displayName, circle: circle.name })}
                >
                  {t('m.closeFriends.add')}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted" role="status" style={{ margin: 0, fontSize: 14 }}>
            {q.trim() ? t('circles.noMatch', { query: q.trim() }) : t('circles.suggestHint')}
          </p>
        )}
      </div>
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('m.circles.deleteTitle', { name: circle.name })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t('circles.keep')}
            </Button>
            <Button variant="danger" loading={busy === 'delete'} onClick={destroy}>
              {t('m.circles.delete')}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>{t('circles.deleteBody')}</p>
      </Dialog>
    </Card>
  );
}
