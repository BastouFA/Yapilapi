'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Avatar, Button, Icon } from '@yapilapi/design-system';
import { suggestionReasonText, type PeopleSuggestion } from '@yapilapi/shared';
import { api, errorMessage, onFollowChange, sharedRequest } from '@/lib/api';
import { useSession } from '@/app/providers';

type Suggestion = PeopleSuggestion;

/** A row of people you might want to follow, with why each is suggested. Dismissed people stay hidden on this device. */
export function SuggestedPeople() {
  const { toast, t, tp } = useSession();
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [followed, setFollowed] = useState<Set<string>>(new Set());
  // Followed elsewhere (their profile, a reel): the button here says so too.
  useEffect(
    () =>
      onFollowChange((id, on) =>
        setFollowed((prev) => {
          const next = new Set(prev);
          if (on) next.add(id);
          else next.delete(id);
          return next;
        }),
      ),
    [],
  );

  useEffect(() => {
    let hidden: string[] = [];
    try {
      hidden = JSON.parse(localStorage.getItem('yp.suggest.hidden') ?? '[]');
    } catch {
      // Storage can be unavailable; show everyone.
    }
    // The desktop sidebar asks for the same list at the same time.
    sharedRequest('suggestions', () => api.me.suggestions()).then(
      (r) => setItems(r.items.filter((s) => !hidden.includes(s.user.id))),
      () => setItems([]),
    );
  }, []);

  const hide = (id: string) => {
    setItems((cur) => cur?.filter((s) => s.user.id !== id) ?? cur);
    try {
      const hidden = JSON.parse(localStorage.getItem('yp.suggest.hidden') ?? '[]') as string[];
      localStorage.setItem('yp.suggest.hidden', JSON.stringify([...hidden, id].slice(-200)));
    } catch {
      // Not remembered; fine.
    }
  };

  if (!items?.length) return null;
  return (
    <section className="suggested" aria-labelledby="suggested-title">
      <h2 id="suggested-title" className="section-title">
        {t('suggested.title')}
      </h2>
      <ul className="suggested__row">
        {items.map((s) => {
          const { user } = s;
          const reason = suggestionReasonText(s, { t, tp });
          const on = followed.has(user.id);
          return (
            <li key={user.id} className="suggested__card">
              <button type="button" className="suggested__hide" aria-label={t('suggested.hide', { name: user.displayName })} onClick={() => hide(user.id)}>
                <Icon name="x" size={14} />
              </button>
              <Link href={`/u/${user.username}`} className="suggested__who">
                <Avatar name={user.displayName} src={user.avatarUrl} size="lg" />
                <bdi className="suggested__name">{user.displayName}</bdi>
                <span className="suggested__reason">{reason}</span>
              </Link>
              <Button
                size="sm"
                variant={on ? 'secondary' : 'primary'}
                aria-pressed={on}
                onClick={async () => {
                  const next = new Set(followed);
                  if (on) next.delete(user.id);
                  else next.add(user.id);
                  setFollowed(next);
                  try {
                    if (on) await api.users.unfollow(user.id);
                    else await api.users.follow(user.id);
                  } catch (e) {
                    setFollowed(followed);
                    toast(errorMessage(e));
                  }
                }}
              >
                {on ? t('profile.unfollow') : t('profile.follow')}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
