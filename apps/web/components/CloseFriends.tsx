'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Avatar, Button, Card } from '@yapilapi/design-system';
import type { PublicUser } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

type Entry = { user: PublicUser; followsYou: boolean };

/**
 * Close friends: people who follow you and see the stories you share with
 * close friends only. Nobody is told when they're added or removed. Search
 * uses the people suggestions, narrowed to your followers.
 */
export function CloseFriendsCard() {
  const { toast, t } = useSession();
  const id = useId();
  const [list, setList] = useState<Entry[] | null>(null);
  const [q, setQ] = useState('');
  const [suggestions, setSuggestions] = useState<PublicUser[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const req = useRef(0);

  useEffect(() => {
    api.closeFriends.list().then(
      (r) => setList(r.items),
      (e) => {
        setList([]);
        toast(errorMessage(e));
      },
    );
  }, [toast]);

  useEffect(() => {
    const n = ++req.current;
    const timer = setTimeout(
      () =>
        api.people.suggest(q.trim(), 12, 'followers').then(
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
      await api.closeFriends.add(u.id);
      setList((cur) => [{ user: u, followsYou: true }, ...(cur ?? []).filter((x) => x.user.id !== u.id)]);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(u: PublicUser) {
    setBusy(u.id);
    try {
      await api.closeFriends.remove(u.id);
      setList((cur) => (cur ?? []).filter((x) => x.user.id !== u.id));
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const onList = new Set((list ?? []).map((x) => x.user.id));
  const addable = suggestions.filter((u) => !onList.has(u.id));

  return (
    <div id="close-friends">
      <Card title={t('m.closeFriends.title')} subtitle={t('m.closeFriends.hint')}>
        <div className="stack">
          <h3 className="yp-field__label" style={{ margin: 0 }}>
            {list ? t('circles.closeFriendsCount', { count: list.length }) : t('m.closeFriends.onList')}
          </h3>
          {list === null ? (
            <p className="muted">{t('common.loading')}</p>
          ) : list.length ? (
            <ul className="close-friends__list">
              {list.map((x) => (
                <li key={x.user.id} className="close-friends__row">
                  <span className="close-friends__dot" aria-hidden />
                  <Avatar name={x.user.displayName} src={x.user.avatarUrl} size="sm" />
                  <span className="sound-row__text">
                    <bdi className="sound-row__title">{x.user.displayName}</bdi>
                    <span className="sound-row__meta">
                      <bdi>@{x.user.username}</bdi>
                      {x.followsYou ? '' : ` · ${t('m.closeFriends.notFollowing')}`}
                    </span>
                  </span>
                  <Button size="sm" variant="ghost" loading={busy === x.user.id} onClick={() => remove(x.user)}>
                    {t('m.closeFriends.remove')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              {t('m.closeFriends.empty')}
            </p>
          )}

          <label htmlFor={`${id}-q`} className="yp-field__label">
            {t('m.closeFriends.addHeading')}
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
            <ul className="close-friends__list" aria-label={t('circles.closeFriendsAddable')}>
              {addable.map((u) => (
                <li key={u.id} className="close-friends__row">
                  <Avatar name={u.displayName} src={u.avatarUrl} size="sm" />
                  <span className="sound-row__text">
                    <bdi className="sound-row__title">{u.displayName}</bdi>
                    <span className="sound-row__meta">
                      <bdi>@{u.username}</bdi>
                    </span>
                  </span>
                  <Button size="sm" variant="secondary" loading={busy === u.id} onClick={() => add(u)}>
                    {t('m.closeFriends.add')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted" role="status" style={{ margin: 0, fontSize: 14 }}>
              {q.trim() ? t('circles.closeFriendsNoMatch', { query: q.trim() }) : t('m.closeFriends.none')}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
