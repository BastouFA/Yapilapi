'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Avatar, Button, Card, Dialog, EmptyState, Select, Skeleton, TextField } from '@yapilapi/design-system';
import type { Circle, CircleKind, PublicUser } from '@yapilapi/shared';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { useSession } from '@/app/providers';

/** Kinds offered when making a circle. ('close_friends' stays for older circles: close friends is its own list now.) */
export const CIRCLE_KIND_LABELS: Partial<Record<CircleKind, string>> = {
  custom: 'Other',
  family: 'Family',
  work: 'Work',
  business: 'Business',
  travel: 'Travel',
};

/**
 * Circles: small groups you share posts with, like Family or Work. Only you see
 * them. People aren't told when you add or remove them, and never see which
 * circles they're in.
 */
export function CirclesManager({ initialId }: { initialId?: string | null }) {
  const { toast } = useSession();
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
    if (!name.trim()) return setError('Give your circle a name.');
    setCreating(true);
    setError(undefined);
    try {
      const { circle } = await api.circles.create({ name: name.trim(), kind });
      setCircles((cur) => [...(cur ?? []), circle]);
      setSelected(circle.id);
      setName('');
      setKind('custom');
      toast(`${circle.name} created. Add people to it below.`);
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
        Share posts with a small group, like Family or Work, by choosing the circle as the audience when you post. Only you see your circles. People
        aren&rsquo;t told when you add or remove them, and never see which circles they&rsquo;re in.
      </p>
      <Card title="New circle" level={2}>
        <form className="stack" onSubmit={create}>
          <div className="row" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <TextField
              label="Name"
              placeholder="Family"
              value={name}
              maxLength={40}
              error={error}
              onChange={(e) => setName(e.currentTarget.value)}
              className="circles-form__name"
            />
            <Select label="Kind" value={kind} onChange={(e) => setKind(e.currentTarget.value as CircleKind)}>
              {Object.entries(CIRCLE_KIND_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
            <Button type="submit" icon="plus" loading={creating}>
              Create
            </Button>
          </div>
        </form>
      </Card>

      {circles === null ? (
        <Skeleton height={120} />
      ) : circles.length ? (
        <ul className="circles__list" aria-label="Your circles">
          {circles.map((c) => (
            <li key={c.id} className="circles__row" aria-current={c.id === selected ? 'true' : undefined}>
              <span className="sound-row__text">
                <bdi className="sound-row__title">{c.name}</bdi>
                <span className="sound-row__meta">
                  {CIRCLE_KIND_LABELS[c.kind] ?? 'Other'} · {c.memberCount === 1 ? '1 person' : `${c.memberCount} people`}
                </span>
              </span>
              <Button size="sm" variant={c.id === selected ? 'primary' : 'secondary'} onClick={() => setSelected(c.id === selected ? null : c.id)}>
                {c.id === selected ? 'Close' : 'Manage'}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No circles yet" body="Make one above, then add the people you want in it." />
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
  const { toast } = useSession();
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
      else toast(`${u.displayName} can't be added.`);
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
    if (!newName.trim()) return setRenameError('Give your circle a name.');
    setBusy('rename');
    try {
      const { circle: c } = await api.circles.update(circle.id, { name: newName.trim() });
      onChange(c);
      setRenaming(false);
      setRenameError(undefined);
      toast('Circle renamed');
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
      toast(`${circle.name} deleted`);
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
      subtitle={circle.memberCount === 1 ? '1 person' : `${circle.memberCount} people`}
      action={
        <div className="row">
          <Button size="sm" variant="ghost" onClick={() => setRenaming((r) => !r)}>
            Rename
          </Button>
          <Button size="sm" variant="ghost" icon="trash" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </div>
      }
    >
      <div className="stack">
        {renaming ? (
          <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={rename}>
            <TextField
              label="New name"
              value={newName}
              maxLength={40}
              error={renameError}
              onChange={(e) => setNewName(e.currentTarget.value)}
              className="circles-form__name"
            />
            <Button type="submit" size="sm" loading={busy === 'rename'}>
              Save
            </Button>
          </form>
        ) : null}

        <h3 className="yp-field__label" style={{ margin: 0 }}>
          In this circle
        </h3>
        {members === null ? (
          <p className="muted">Loading</p>
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
                <Button size="sm" variant="ghost" loading={busy === u.id} onClick={() => remove(u)} aria-label={`Remove ${u.displayName} from ${circle.name}`}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            Nobody yet. Add people below.
          </p>
        )}

        <label htmlFor={`${id}-q`} className="yp-field__label">
          Add people
        </label>
        <input
          id={`${id}-q`}
          className="yp-input"
          type="search"
          autoComplete="off"
          placeholder="Type a name or username"
          value={q}
          maxLength={60}
          onChange={(e) => setQ(e.currentTarget.value)}
        />
        {addable.length ? (
          <ul className="close-friends__list" aria-label="People you can add">
            {addable.map((u) => (
              <li key={u.id} className="close-friends__row">
                <Avatar name={u.displayName} src={u.avatarUrl} size="sm" />
                <span className="sound-row__text">
                  <bdi className="sound-row__title">{u.displayName}</bdi>
                  <span className="sound-row__meta">
                    <bdi>@{u.username}</bdi>
                  </span>
                </span>
                <Button size="sm" variant="secondary" loading={busy === u.id} onClick={() => add(u)} aria-label={`Add ${u.displayName} to ${circle.name}`}>
                  Add
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted" role="status" style={{ margin: 0, fontSize: 14 }}>
            {q.trim() ? `Nobody matches "${q.trim()}".` : 'Friends and people you follow show up here.'}
          </p>
        )}
      </div>
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${circle.name}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button variant="danger" loading={busy === 'delete'} onClick={destroy}>
              Delete circle
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>Posts you shared with this circle stay, but only you will see them. Nobody in it is told.</p>
      </Dialog>
    </Card>
  );
}
