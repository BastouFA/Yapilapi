'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Alert, Avatar, Button, Skeleton } from '@yapilapi/design-system';
import type { OnboardingStep } from '@yapilapi/api-client';
import type { PublicUser } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { FindFriends } from '@/components/FindFriends';
import { useSession } from '../providers';

type Suggestion = { user: PublicUser; reason: string; bio: string };
const STEPS = 3;
/** How many suggested creators start ticked. */
const PRESELECTED = 5;

/**
 * Three short steps after sign-up, so Home is full from the first minute:
 * 1. interests (topics and what's trending), which For you uses straight away;
 * 2. creators who post about them, the top five ticked (untick freely);
 * 3. find friends from a pasted list of emails (optional).
 */
export default function Onboarding() {
  const { me, loading, refresh, t } = useSession();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [topics, setTopics] = useState<{ slug: string; name: string }[] | null>(null);
  const [trending, setTrending] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [people, setPeople] = useState<Suggestion[] | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<OnboardingStep[]>([]);
  const [friends, setFriends] = useState<{ checked: number; found: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && !me) router.replace('/login');
    if (!loading && me?.onboarded) router.replace('/home');
  }, [loading, me, router]);
  useEffect(() => {
    api.topics().then(
      (r) => setTopics(r.items),
      () => setTopics([]),
    );
    api.trending(12).then(
      (r) => setTrending(r.items.map((i) => i.tag)),
      () => {},
    );
  }, []);

  const options = [...new Set([...trending, ...(topics ?? []).map((tp) => tp.slug)])];
  const need = Math.min(3, options.length);
  const record = (s: OnboardingStep) => setLog((l) => [...l.filter((x) => x.step !== s.step), s]);

  function togglePick(slug: string) {
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(slug)) n.delete(slug);
      else n.add(slug);
      return n;
    });
  }

  async function saveInterests() {
    setBusy(true);
    setError(null);
    try {
      if (picked.size) await api.me.setInterests([...picked]);
      record({ step: 'interests', skipped: picked.size === 0, count: picked.size });
      // Creators who post about the chosen interests; everyone else if there are none yet.
      let items = (await api.me.suggestions({ kind: 'creators', limit: 12 })).items;
      if (items.length < PRESELECTED) {
        const more = (await api.me.suggestions()).items.filter((s) => !items.some((i) => i.user.id === s.user.id));
        items = [...items, ...more].slice(0, 12);
      }
      setPeople(items);
      setTicked(new Set(items.slice(0, PRESELECTED).map((s) => s.user.id)));
      setStep(1);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function followTicked(skip: boolean) {
    setBusy(true);
    setError(null);
    const ids = skip ? [] : [...ticked];
    const results = await Promise.allSettled(ids.map((id) => api.users.follow(id)));
    const followed = results.filter((r) => r.status === 'fulfilled').length;
    if (followed < ids.length) setError(t('error.generic'));
    record({ step: 'follow', skipped: skip || ids.length === 0, count: followed });
    setBusy(false);
    setStep(2);
  }

  async function finish() {
    setBusy(true);
    const steps = [...log.filter((s) => s.step !== 'friends'), { step: 'friends' as const, skipped: !friends, count: friends?.found ?? 0 }];
    try {
      await api.me.completeOnboarding({ platform: 'web', steps });
      await refresh();
      router.replace('/home');
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <main className="auth" id="main">
      <div className="auth__card onboarding" style={{ maxWidth: 560 }}>
        <div className="onboarding__progress">
          <span className="muted">{t('onboarding.step', { step: step + 1, total: STEPS })}</span>
          <div className="onboarding__bar" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS} aria-valuenow={step + 1}>
            <span style={{ width: `${((step + 1) / STEPS) * 100}%` }} />
          </div>
        </div>
        {error ? <Alert tone="danger">{error}</Alert> : null}

        {step === 0 ? (
          <div className="stack">
            <h1>{t('onboarding.interests.title')}</h1>
            <p className="muted">{t('onboarding.interests.body')}</p>
            {trending.length ? (
              <section className="stack-sm" aria-labelledby="ob-trending">
                <h2 id="ob-trending" className="section-title">
                  {t('onboarding.trending')}
                </h2>
                <div className="topic-grid" role="group" aria-labelledby="ob-trending">
                  {trending.map((tag) => (
                    <button key={tag} type="button" aria-pressed={picked.has(tag)} onClick={() => togglePick(tag)}>
                      <bdi>#{tag}</bdi>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
            <section className="stack-sm" aria-labelledby="ob-topics">
              <h2 id="ob-topics" className="section-title">
                {t('onboarding.topics')}
              </h2>
              <div className="topic-grid" role="group" aria-labelledby="ob-topics">
                {topics
                  ? topics
                      .filter((tp) => !trending.includes(tp.slug))
                      .map((tp) => (
                        <button key={tp.slug} type="button" aria-pressed={picked.has(tp.slug)} onClick={() => togglePick(tp.slug)}>
                          {tp.name}
                        </button>
                      ))
                  : Array.from({ length: 8 }, (_, i) => <Skeleton key={i} height={40} width={96} />)}
              </div>
            </section>
            <Button block disabled={topics === null || picked.size < need} loading={busy} onClick={saveInterests}>
              {picked.size < need ? t('onboarding.pickMore', { count: need - picked.size }) : t('onboarding.continue')}
            </Button>
          </div>
        ) : step === 1 ? (
          <div className="stack">
            <h1>{t('onboarding.follow.title')}</h1>
            {people?.length ? (
              <>
                <p className="muted">{t('onboarding.follow.body')}</p>
                <ul className="onboarding__people" aria-label={t('onboarding.follow.title')}>
                  {people.map((p) => {
                    const on = ticked.has(p.user.id);
                    return (
                      <li key={p.user.id}>
                        <label className="onboarding__person">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() =>
                              setTicked((s) => {
                                const n = new Set(s);
                                if (on) n.delete(p.user.id);
                                else n.add(p.user.id);
                                return n;
                              })
                            }
                          />
                          <Avatar name={p.user.displayName} src={p.user.avatarUrl} />
                          <span className="onboarding__who">
                            <bdi className="onboarding__name">{p.user.displayName}</bdi>
                            <span className="muted">{p.reason}</span>
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : (
              <p className="muted">{t('onboarding.follow.empty')}</p>
            )}
            <Button block loading={busy} onClick={() => followTicked(false)}>
              {t('onboarding.continue')}
            </Button>
            {people?.length ? (
              <Button block variant="ghost" disabled={busy} onClick={() => followTicked(true)}>
                {t('onboarding.skip')}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="stack">
            <h1>{t('friends.title')}</h1>
            <FindFriends onChecked={setFriends} />
            <Button block loading={busy} onClick={finish}>
              {t('onboarding.finish')}
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}
