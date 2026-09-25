'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, Avatar, Button, List, ListItem, Skeleton } from '@yapilapi/design-system';
import type { PublicUser } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '../providers';

/** Sign up → profile → interests → follow → Home. */
export default function Onboarding() {
  const { me, loading, refresh, t } = useSession();
  const router = useRouter();
  const [step, setStep] = useState<'interests' | 'follow'>('interests');
  const [topics, setTopics] = useState<{ slug: string; name: string }[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [people, setPeople] = useState<{ user: PublicUser; reason: string; bio: string }[] | null>(null);
  const [following, setFollowing] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && !me) router.replace('/login');
    if (!loading && me?.onboarded) router.replace('/home');
  }, [loading, me, router]);
  useEffect(() => {
    api
      .topics()
      .then((r) => setTopics(r.items))
      .catch(() => {});
  }, []);

  async function saveInterests() {
    setBusy(true);
    setError(null);
    try {
      await api.me.setInterests([...picked]);
      setPeople((await api.me.suggestions()).items);
      setStep('follow');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleFollow(u: PublicUser) {
    const on = following.has(u.id);
    setFollowing((s) => {
      const n = new Set(s);
      if (on) n.delete(u.id);
      else n.add(u.id);
      return n;
    });
    try {
      if (on) await api.users.unfollow(u.id);
      else await api.users.follow(u.id);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function finish() {
    setBusy(true);
    await api.me.completeOnboarding();
    await refresh();
    router.replace('/home');
  }

  return (
    <main className="auth" id="main">
      <div className="auth__card" style={{ maxWidth: 560 }}>
        {step === 'interests' ? (
          <div className="stack">
            <h1>{t('onboarding.interests.title')}</h1>
            <p className="muted">{t('onboarding.interests.body')}</p>
            {error ? <Alert tone="danger">{error}</Alert> : null}
            <div className="topic-grid" role="group" aria-label="Interests">
              {topics.length
                ? topics.map((tp) => (
                    <button
                      key={tp.slug}
                      type="button"
                      aria-pressed={picked.has(tp.slug)}
                      onClick={() =>
                        setPicked((s) => {
                          const n = new Set(s);
                          if (n.has(tp.slug)) n.delete(tp.slug);
                          else n.add(tp.slug);
                          return n;
                        })
                      }
                    >
                      {tp.name}
                    </button>
                  ))
                : Array.from({ length: 8 }, (_, i) => <Skeleton key={i} height={40} width={96} />)}
            </div>
            <Button block disabled={picked.size < 3} loading={busy} onClick={saveInterests}>
              {picked.size < 3 ? `Pick ${3 - picked.size} more` : t('onboarding.continue')}
            </Button>
          </div>
        ) : (
          <div className="stack">
            <h1>{t('onboarding.follow.title')}</h1>
            {error ? <Alert tone="danger">{error}</Alert> : null}
            {people?.length ? (
              <List label="Suggested people">
                {people.map((p) => (
                  <ListItem
                    key={p.user.id}
                    start={<Avatar name={p.user.displayName} src={p.user.avatarUrl} />}
                    primary={p.user.displayName}
                    secondary={p.reason}
                    end={
                      <Button size="sm" variant={following.has(p.user.id) ? 'secondary' : 'primary'} onClick={() => toggleFollow(p.user)}>
                        {following.has(p.user.id) ? t('profile.unfollow') : t('profile.follow')}
                      </Button>
                    }
                  />
                ))}
              </List>
            ) : (
              <p className="muted">No suggestions yet. You can find people from Discover.</p>
            )}
            <Button block loading={busy} onClick={finish}>
              {t('onboarding.finish')}
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}
