'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { Avatar, Button, Card, Dialog, EmptyState, Menu, Skeleton, TextField, type MenuAction } from '@yapilapi/design-system';
import {
  formatList,
  MAX_SQUAD_MEMBERS,
  SQUAD_COLORS,
  SQUAD_INK,
  SQUAD_RULES,
  squadColor,
  type MessageKey,
  type PublicUser,
  type Squad,
  type SquadCard,
  type SquadColor,
  type SquadCover as Cover,
  type SquadMember,
  type SquadMemory,
} from '@yapilapi/shared';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { useSession } from '@/app/providers';
import { PostList, StaticPostList } from '@/components/PostList';

/**
 * Squads (docs/product/squads.md): small private groups of up to 10 friends, with a shared feed,
 * a shared story, a chat and a weekly memory. Only the people in a squad see it.
 */

/** A squad's cover: its photo, or its colour with the name on it (white on each colour is AA). */
export function SquadCover({ name, cover, size = 'md' }: { name: string; cover: Cover; size?: 'sm' | 'md' | 'lg' }) {
  const photo = cover.photo?.variants?.medium ?? cover.photo?.url;
  return (
    <div className={`squad-cover squad-cover--${size}`} style={{ background: squadColor(cover.color), color: SQUAD_INK }} aria-hidden="true">
      {photo ? <img src={photo} alt="" loading="lazy" /> : <span className="squad-cover__initial">{Array.from(name.trim())[0]?.toUpperCase() ?? ''}</span>}
    </div>
  );
}

/** Colours for a squad's cover, as a labelled radio group (the names are the profile accents'). */
function ColorPicker({ value, onChange }: { value: SquadColor; onChange: (c: SquadColor) => void }) {
  const { t } = useSession();
  const id = useId();
  return (
    <fieldset className="squad-colors">
      <legend className="yp-field__label">{t('squads.color')}</legend>
      <div className="squad-colors__row">
        {SQUAD_COLORS.map((c) => (
          <label key={c} className="squad-colors__swatch" style={{ background: squadColor(c) }} title={t(`ps.accent.${c}` as MessageKey)}>
            <input
              type="radio"
              name={`${id}-color`}
              value={c}
              checked={value === c}
              onChange={() => onChange(c)}
              aria-label={t(`ps.accent.${c}` as MessageKey)}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A cover photo: upload one of yours, or go back to the colour. */
function PhotoPicker({ value, onChange }: { value: { id: string; url: string } | null; onChange: (v: { id: string; url: string } | null) => void }) {
  const { t, toast } = useSession();
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  async function pick(files: FileList | null) {
    const f = files?.[0];
    if (ref.current) ref.current.value = '';
    if (!f) return;
    setBusy(true);
    try {
      const { media } = await api.media.upload(f);
      onChange({ id: media.id, url: media.url });
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
      <input ref={ref} type="file" accept="image/*" hidden onChange={(e) => pick(e.currentTarget.files)} />
      <Button size="sm" variant="secondary" icon="image" loading={busy} onClick={() => ref.current?.click()}>
        {value ? t('squads.photo') : t('squads.photo.choose')}
      </Button>
      {value ? (
        <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
          {t('squads.photo.remove')}
        </Button>
      ) : null}
    </div>
  );
}

/** People you could invite (friends, and people you follow who follow you back), with a search. */
function PeoplePicker({ squadId, chosen, onToggle, max }: { squadId?: string; chosen: string[]; onToggle: (u: PublicUser) => void; max: number }) {
  const { t } = useSession();
  const id = useId();
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<PublicUser[] | null>(null);
  const req = useRef(0);
  useEffect(() => {
    const n = ++req.current;
    const timer = setTimeout(
      () =>
        api.squads.candidates({ squadId, q: q.trim() || undefined }).then(
          (r) => n === req.current && setPeople(r.items),
          () => n === req.current && setPeople([]),
        ),
      q ? 150 : 0,
    );
    return () => clearTimeout(timer);
  }, [q, squadId]);
  return (
    <div className="stack-sm">
      <label htmlFor={`${id}-q`} className="yp-field__label">
        {t('squads.invite')}
      </label>
      <p className="muted" id={`${id}-hint`} style={{ margin: 0, fontSize: 14 }}>
        {t('squads.inviteHint')}
      </p>
      <input
        id={`${id}-q`}
        className="yp-input"
        type="search"
        autoComplete="off"
        aria-describedby={`${id}-hint`}
        placeholder={t('m.collab.search')}
        value={q}
        maxLength={60}
        onChange={(e) => setQ(e.currentTarget.value)}
      />
      {people === null ? (
        <Skeleton height={80} />
      ) : people.length ? (
        <ul className="close-friends__list" aria-label={t('squads.invite')}>
          {people.map((u) => {
            const on = chosen.includes(u.id);
            return (
              <li key={u.id} className="close-friends__row">
                <label className="squad-pick">
                  <input type="checkbox" checked={on} disabled={!on && chosen.length >= max} onChange={() => onToggle(u)} />
                  <Avatar name={u.displayName} src={u.avatarUrl} size="sm" />
                  <span className="sound-row__text">
                    <bdi className="sound-row__title">{u.displayName}</bdi>
                    <span className="sound-row__meta">
                      <bdi>@{u.username}</bdi>
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted" role="status" style={{ margin: 0, fontSize: 14 }}>
          {q.trim() ? t('m.group.noMatch', { query: q.trim() }) : t('squads.noCandidates')}
        </p>
      )}
    </div>
  );
}

/** Your squads, the invites waiting for you, and making a new one. */
export function SquadsHome() {
  const { t, tp, toast } = useSession();
  const [items, setItems] = useState<SquadCard[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [making, setMaking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setLoadError(null);
    api.squads.list().then(
      (r) => setItems(r.items),
      (e) => setLoadError(errorMessage(e)),
    );
  }, [attempt]);

  async function answer(s: SquadCard, join: boolean) {
    setBusy(s.id);
    try {
      if (join) {
        await api.squads.accept(s.id);
        toast(t('squads.joined', { name: s.name }));
      } else await api.squads.decline(s.id);
      setAttempt((n) => n + 1);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>
        {t('squads.intro', { max: MAX_SQUAD_MEMBERS })}
      </p>
      {making ? (
        <NewSquad onCancel={() => setMaking(false)} onMade={() => (setMaking(false), setAttempt((n) => n + 1))} />
      ) : (
        <div>
          <Button icon="plus" onClick={() => setMaking(true)}>
            {t('squads.new')}
          </Button>
        </div>
      )}
      {items === null && loadError ? (
        <EmptyState title={loadError} action={<Button onClick={() => setAttempt((n) => n + 1)}>{t('m.common.retry')}</Button>} />
      ) : items === null ? (
        <Skeleton height={120} />
      ) : items.length ? (
        <ul className="squads__list" aria-label={t('squads.title')}>
          {items.map((s) => (
            <li key={s.id} className="squads__row">
              <SquadCover name={s.name} cover={s.cover} size="sm" />
              <span className="sound-row__text">
                {s.invitedBy ? (
                  <bdi className="sound-row__title">{s.name}</bdi>
                ) : (
                  <Link href={`/squads/${s.id}`} className="sound-row__title">
                    <bdi>{s.name}</bdi>
                  </Link>
                )}
                <span className="sound-row__meta">
                  {s.invitedBy ? t('squads.invitedBy', { name: s.invitedBy.displayName }) : tp('squads.people', s.memberCount)}
                </span>
              </span>
              {s.invitedBy ? (
                <span className="row">
                  <Button size="sm" loading={busy === s.id} onClick={() => answer(s, true)}>
                    {t('squads.join')}
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy === s.id} onClick={() => answer(s, false)}>
                    {t('m.common.decline')}
                  </Button>
                </span>
              ) : (
                <span className="squads__faces" aria-hidden="true">
                  {s.faces.map((u) => (
                    <Avatar key={u.id} name={u.displayName} src={u.avatarUrl} size="sm" />
                  ))}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={t('squads.empty')} />
      )}
    </div>
  );
}

/** A new squad: name, cover colour or photo, and 2 to 9 people to invite. */
function NewSquad({ onCancel, onMade }: { onCancel: () => void; onMade: () => void }) {
  const { t, toast } = useSession();
  const [name, setName] = useState('');
  const [color, setColor] = useState<SquadColor>('coral');
  const [photo, setPhoto] = useState<{ id: string; url: string } | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [pickError, setPickError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (chosen.length < SQUAD_RULES.minInvites) return setPickError(t('squads.invitePick', { min: SQUAD_RULES.minInvites }));
    setSaving(true);
    setError(undefined);
    setPickError(null);
    try {
      const { squad } = await api.squads.create({ name: name.trim(), color, coverMediaId: photo?.id, userIds: chosen });
      toast(t('squads.created'));
      onMade();
      window.location.assign(`/squads/${squad.id}`);
    } catch (err) {
      const f = fieldErrors(err);
      if (f.name) setError(f.name);
      else setPickError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card title={t('squads.new')} level={2}>
      <form className="stack" onSubmit={submit} noValidate>
        <SquadCover
          name={name || '?'}
          cover={{ color, photo: photo ? { id: photo.id, kind: 'image', url: photo.url, altText: null, width: null, height: null } : null }}
        />
        <TextField
          label={t('squads.name')}
          value={name}
          maxLength={SQUAD_RULES.nameMax}
          required
          error={error}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <ColorPicker value={color} onChange={setColor} />
        <PhotoPicker value={photo} onChange={setPhoto} />
        <PeoplePicker
          chosen={chosen}
          max={MAX_SQUAD_MEMBERS - 1}
          onToggle={(u) => setChosen((cur) => (cur.includes(u.id) ? cur.filter((x) => x !== u.id) : [...cur, u.id]))}
        />
        {pickError ? (
          <p className="yp-field__error" role="alert" style={{ margin: 0 }}>
            {pickError}
          </p>
        ) : null}
        <div className="row">
          <Button type="submit" loading={saving} disabled={!name.trim()}>
            {t('squads.create')}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** "Your squad's week", pinned on the squad page until the next one. */
function MemoryCard({ memory }: { memory: SquadMemory }) {
  const { t, tp, locale } = useSession();
  const total = memory.counts.posts + memory.counts.reels + memory.counts.stories;
  const date = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${memory.weekStart}T00:00:00Z`));
  return (
    <Card title={t('squads.memory.title')} subtitle={t('squads.memory.week', { date })} level={2}>
      <div className="stack-sm">
        <p style={{ margin: 0 }}>{tp('squads.memory.moments', total)}</p>
        {memory.people.length ? (
          <p className="muted" style={{ margin: 0 }}>
            {t('squads.memory.by', {
              names: formatList(
                memory.people.map((u) => u.displayName),
                locale,
              ),
            })}
          </p>
        ) : null}
        {memory.top.length ? <StaticPostList posts={memory.top} /> : null}
      </div>
    </Card>
  );
}

/** One squad: its cover, what to do (share, story, chat), the weekly memory, the feed and the people. */
export function SquadPage({ id }: { id: string }) {
  const { t, tp, toast, me } = useSession();
  const [squad, setSquad] = useState<Squad | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [inviting, setInviting] = useState<string[] | null>(null);
  const [confirm, setConfirm] = useState<null | 'leave' | 'delete' | { owner: SquadMember }>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    api.squads.get(id).then(
      (r) => setSquad(r.squad),
      (e) => setError(errorMessage(e)),
    );
  }, [id, attempt]);

  if (!squad && error)
    return (
      <EmptyState level={1} title={t('squads.title')} body={error} action={<Button onClick={() => setAttempt((n) => n + 1)}>{t('m.common.retry')}</Button>} />
    );
  if (!squad) return <Skeleton height={240} />;

  const role = squad.viewer.role;
  const manager = role === 'owner' || role === 'admin';
  const run = async (key: string, fn: () => Promise<{ squad?: Squad } | unknown>) => {
    setBusy(key);
    try {
      const r = (await fn()) as { squad?: Squad } | undefined;
      if (r?.squad) setSquad(r.squad);
      return true;
    } catch (e) {
      toast(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (squad.viewer.invited)
    return (
      <div className="stack">
        <SquadCover name={squad.name} cover={squad.cover} size="lg" />
        <h1 style={{ margin: 0 }}>
          <bdi>{squad.name}</bdi>
        </h1>
        {squad.viewer.invitedBy ? <p style={{ margin: 0 }}>{t('squads.invitedBy', { name: squad.viewer.invitedBy.displayName })}</p> : null}
        <div className="row">
          <Button loading={busy === 'join'} onClick={() => run('join', () => api.squads.accept(squad.id))}>
            {t('squads.join')}
          </Button>
          <Button variant="ghost" onClick={() => run('decline', () => api.squads.decline(squad.id)).then((ok) => ok && window.location.assign('/squads'))}>
            {t('m.common.decline')}
          </Button>
        </div>
      </div>
    );

  const roleLabel = (m: SquadMember) =>
    m.invited ? t('m.rooms.invitedLabel') : m.role === 'owner' ? t('m.role.owner') : m.role === 'admin' ? t('m.role.admin') : null;
  const canRemove = (m: SquadMember) => m.user.id !== me?.id && m.role !== 'owner' && (role === 'owner' || (role === 'admin' && m.role !== 'admin'));
  // What the owner and admins can do with each person, in one menu (it fits a phone's width).
  const actionsFor = (m: SquadMember): MenuAction[] => [
    ...(role === 'owner' && !m.invited && m.role !== 'owner'
      ? [
          {
            label: m.role === 'admin' ? t('chat.group.dropAdmin') : t('chat.group.makeAdmin'),
            icon: (m.role === 'admin' ? 'user' : 'check-circle') as MenuAction['icon'],
            onSelect: () => void run(`role:${m.user.id}`, () => api.squads.setRole(squad.id, m.user.id, m.role === 'admin' ? 'member' : 'admin')),
          },
          { label: t('squads.makeOwner'), icon: 'key' as MenuAction['icon'], onSelect: () => setConfirm({ owner: m }) },
        ]
      : []),
    ...(canRemove(m)
      ? [
          {
            label: t('m.group.removePerson', { name: m.user.displayName }),
            icon: 'x-circle' as MenuAction['icon'],
            danger: true,
            onSelect: () => void run(`rm:${m.user.id}`, () => api.squads.removeMember(squad.id, m.user.id)),
          },
        ]
      : []),
  ];
  const full = squad.memberCount >= MAX_SQUAD_MEMBERS;

  return (
    <div className="stack">
      <div className="squad-head">
        <SquadCover name={squad.name} cover={squad.cover} size="lg" />
        <div className="stack-sm">
          <h1 style={{ margin: 0 }}>
            <bdi>{squad.name}</bdi>
          </h1>
          <p className="muted" style={{ margin: 0 }}>
            {tp('squads.people', squad.memberCount)}
          </p>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <Link href={`/create?squad=${squad.id}`} className="yp-btn yp-btn--primary yp-btn--sm">
              {t('squads.share')}
            </Link>
            <Link href={`/create?mode=story&squad=${squad.id}`} className="yp-btn yp-btn--secondary yp-btn--sm">
              {t('squads.addStory')}
            </Link>
            {squad.conversationId ? (
              <Link href={`/inbox/${squad.conversationId}`} className="yp-btn yp-btn--secondary yp-btn--sm">
                {t('mixes.share.open')}
              </Link>
            ) : null}
          </div>
        </div>
      </div>

      {squad.memory ? <MemoryCard memory={squad.memory} /> : null}

      <SquadFeed id={squad.id} />

      <Card title={t('m.community.membersTab')} subtitle={tp('squads.people', squad.memberCount)} level={2}>
        <div className="stack">
          <ul className="close-friends__list">
            {squad.members.map((m) => (
              <li key={m.user.id} className="close-friends__row">
                <Avatar name={m.user.displayName} src={m.user.avatarUrl} size="sm" />
                <span className="sound-row__text">
                  <Link href={`/u/${m.user.username}`} className="sound-row__title">
                    <bdi>{m.user.displayName}</bdi>
                  </Link>
                  <span className="sound-row__meta">
                    <bdi>@{m.user.username}</bdi>
                    {roleLabel(m) ? ` · ${roleLabel(m)}` : ''}
                  </span>
                </span>
                {actionsFor(m).length ? <Menu label={t('chat.group.optionsFor', { name: m.user.displayName })} actions={actionsFor(m)} /> : null}
              </li>
            ))}
          </ul>
          {full ? (
            <p className="muted" style={{ margin: 0 }}>
              {t('squads.full', { max: MAX_SQUAD_MEMBERS })}
            </p>
          ) : inviting ? (
            <div className="stack-sm">
              <PeoplePicker
                squadId={squad.id}
                chosen={inviting}
                max={MAX_SQUAD_MEMBERS - squad.memberCount}
                onToggle={(u) => setInviting((cur) => ((cur ?? []).includes(u.id) ? (cur ?? []).filter((x) => x !== u.id) : [...(cur ?? []), u.id]))}
              />
              <div className="row">
                <Button
                  disabled={!inviting.length}
                  loading={busy === 'invite'}
                  onClick={() =>
                    run('invite', async () => {
                      const r = await api.squads.invite(squad.id, inviting);
                      toast(tp('squads.invited', r.invited));
                      setInviting(null);
                      return r;
                    })
                  }
                >
                  {t('friends.invite')}
                </Button>
                <Button variant="ghost" onClick={() => setInviting(null)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button variant="secondary" icon="plus" onClick={() => setInviting([])}>
                {t('squads.invite')}
              </Button>
            </div>
          )}
        </div>
      </Card>

      {manager ? <SquadSettings squad={squad} onSaved={setSquad} /> : null}

      <div className="row" style={{ flexWrap: 'wrap' }}>
        {role === 'owner' ? (
          <>
            <p className="muted" style={{ margin: 0, flexBasis: '100%' }}>
              {t('squads.ownerNote')}
            </p>
            <Button variant="danger" onClick={() => setConfirm('delete')}>
              {t('squads.delete')}
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={() => setConfirm('leave')}>
            {t('squads.leave')}
          </Button>
        )}
      </div>

      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm === 'delete' ? t('squads.delete') : confirm === 'leave' ? t('squads.leave') : t('squads.makeOwner')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant={confirm === 'delete' ? 'danger' : 'primary'}
              loading={busy === 'confirm'}
              onClick={async () => {
                const c = confirm;
                if (!c) return;
                const ok = await run('confirm', () =>
                  c === 'delete' ? api.squads.remove(squad.id) : c === 'leave' ? api.squads.leave(squad.id) : api.squads.makeOwner(squad.id, c.owner.user.id),
                );
                setConfirm(null);
                if (ok && (c === 'delete' || c === 'leave')) window.location.assign('/squads');
              }}
            >
              {confirm === 'delete' ? t('m.common.delete') : confirm === 'leave' ? t('squads.leave') : t('squads.makeOwner')}
            </Button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          {confirm === 'delete'
            ? t('squads.deleteConfirm', { name: squad.name })
            : confirm === 'leave'
              ? t('squads.leaveConfirm', { name: squad.name })
              : confirm
                ? t('squads.makeOwnerConfirm', { name: confirm.owner.user.displayName })
                : null}
        </p>
      </Dialog>
    </div>
  );
}

/** The squad's posts and reels, newest first. */
function SquadFeed({ id }: { id: string }) {
  const { t } = useSession();
  return (
    <section aria-label={t('squads.share')}>
      <PostList load={(cursor) => api.squads.posts(id, cursor)} empty={t('squads.feedEmpty')} reloadKey={id} showEnd={false} />
    </section>
  );
}

/** Rename the squad or change its cover (owner and admins). */
function SquadSettings({ squad, onSaved }: { squad: Squad; onSaved: (s: Squad) => void }) {
  const { t, toast } = useSession();
  const [name, setName] = useState(squad.name);
  const [color, setColor] = useState<SquadColor>(squad.cover.color);
  const [photo, setPhoto] = useState<{ id: string; url: string } | null>(squad.cover.photo ? { id: squad.cover.photo.id, url: squad.cover.photo.url } : null);
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const { squad: s } = await api.squads.edit(squad.id, {
        name: name.trim(),
        color,
        ...(photo?.id !== squad.cover.photo?.id ? { coverMediaId: photo?.id ?? null } : {}),
      });
      onSaved(s);
      setError(undefined);
      toast(t('common.saved'));
    } catch (err) {
      setError(fieldErrors(err).name ?? errorMessage(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card title={t('m.title.settings')} level={2}>
      <form className="stack" onSubmit={save}>
        <TextField label={t('squads.name')} value={name} maxLength={SQUAD_RULES.nameMax} error={error} onChange={(e) => setName(e.currentTarget.value)} />
        <ColorPicker value={color} onChange={setColor} />
        <PhotoPicker value={photo} onChange={setPhoto} />
        <div>
          <Button type="submit" loading={saving} disabled={!name.trim()}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
