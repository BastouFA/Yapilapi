import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { OnboardingStep } from '../../../packages/api-client/src/index';
import type { PublicUser } from '../../../packages/shared/src/types';
import { client, errorMessage } from '../lib/api';
import { FriendsFinder } from '../lib/friends';
import { useT } from '../lib/i18n';
import { useSession } from '../lib/session';
import { radius, space } from '../lib/theme';
import { Avatar, Button, Icon, Loading, Notice, Title, useColors, userText } from '../lib/ui';

type Suggestion = { user: PublicUser; reason: string };
const STEPS = 3;
/** How many suggested creators start ticked. */
const PRESELECTED = 5;

/**
 * Three short steps for a new account, the same as on the web: interests (topics and what's
 * trending), creators to follow (the top five ticked), then find friends from contacts.
 */
export default function Onboarding() {
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const { refresh } = useSession();
  const [step, setStep] = useState(0);
  const [topics, setTopics] = useState<{ slug: string; name: string }[] | null>(null);
  const [trending, setTrending] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [people, setPeople] = useState<Suggestion[] | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<OnboardingStep[]>([]);
  const [friends, setFriends] = useState<{ checked: number; found: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const api = await client();
      const [tp, tr] = await Promise.all([api.topics().catch(() => ({ items: [] })), api.trending(12).catch(() => ({ items: [] }))]);
      setTrending(tr.items.map((i) => i.tag));
      setTopics(tp.items);
    })();
  }, []);

  const options = [...new Set([...trending, ...(topics ?? []).map((x) => x.slug)])];
  const need = Math.min(3, options.length);
  const record = (s: OnboardingStep) => setLog((l) => [...l.filter((x) => x.step !== s.step), s]);
  const flip = (set: Set<string>, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  };

  async function saveInterests() {
    setBusy(true);
    setError(null);
    try {
      const api = await client();
      if (picked.size) await api.me.setInterests([...picked]);
      record({ step: 'interests', skipped: picked.size === 0, count: picked.size });
      let items: Suggestion[] = (await api.me.suggestions({ kind: 'creators', limit: 12 })).items;
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

  async function follow(skip: boolean) {
    setBusy(true);
    setError(null);
    const api = await client();
    const ids = skip ? [] : [...ticked];
    const results = await Promise.allSettled(ids.map((id) => api.users.follow(id)));
    const followed = results.filter((r) => r.status === 'fulfilled').length;
    if (followed < ids.length) setError(t('error.generic'));
    record({ step: 'follow', skipped: skip || !ids.length, count: followed });
    setBusy(false);
    setStep(2);
  }

  async function finish() {
    setBusy(true);
    try {
      const steps = [...log.filter((s) => s.step !== 'friends'), { step: 'friends' as const, skipped: !friends, count: friends?.found ?? 0 }];
      await (await client()).me.completeOnboarding({ platform: 'mobile', steps });
      await refresh();
      router.replace('/');
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  const chip = (id: string, label: string) => {
    const on = picked.has(id);
    return (
      <Pressable
        key={id}
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        onPress={() => setPicked((s) => flip(s, id))}
        style={{
          height: 40,
          paddingHorizontal: space[4],
          borderRadius: radius.full,
          borderWidth: 1,
          borderColor: on ? c.yapi : c.lineStrong,
          backgroundColor: on ? c.yapi : c.surface,
          justifyContent: 'center',
        }}
      >
        <Text style={[{ color: on ? c.onYapi : c.ink, fontWeight: '600', fontSize: 14 }, userText]}>{label}</Text>
      </Pressable>
    );
  };

  return (
    <ScrollView
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], paddingTop: insets.top + space[4], paddingBottom: insets.bottom + space[8], gap: space[4] }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ gap: space[2] }}>
        <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('onboarding.step', { step: step + 1, total: STEPS })}</Text>
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 1, max: STEPS, now: step + 1 }}
          style={{ height: 6, borderRadius: 3, backgroundColor: c.surfaceSunken, overflow: 'hidden' }}
        >
          <View style={{ width: `${((step + 1) / STEPS) * 100}%`, height: '100%', backgroundColor: c.yapi }} />
        </View>
      </View>
      {error ? <Notice tone="danger">{error}</Notice> : null}

      {step === 0 ? (
        <>
          <Title sub={t('onboarding.interests.body')}>{t('onboarding.interests.title')}</Title>
          {topics === null ? (
            <Loading />
          ) : (
            <>
              {trending.length ? (
                <View style={{ gap: space[2] }}>
                  <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>
                    {t('onboarding.trending')}
                  </Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>{trending.map((tag) => chip(tag, `#${tag}`))}</View>
                </View>
              ) : null}
              <View style={{ gap: space[2] }}>
                <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>
                  {t('onboarding.topics')}
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
                  {topics.filter((x) => !trending.includes(x.slug)).map((x) => chip(x.slug, x.name))}
                </View>
              </View>
            </>
          )}
          <Button
            label={picked.size < need ? t('onboarding.pickMore', { count: need - picked.size }) : t('onboarding.continue')}
            disabled={busy || topics === null || picked.size < need}
            onPress={() => void saveInterests()}
          />
        </>
      ) : step === 1 ? (
        <>
          <Title sub={people?.length ? t('onboarding.follow.body') : undefined}>{t('onboarding.follow.title')}</Title>
          {people?.length ? (
            people.map((p) => {
              const on = ticked.has(p.user.id);
              return (
                <Pressable
                  key={p.user.id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={p.user.displayName}
                  onPress={() => setTicked((s) => flip(s, p.user.id))}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space[3],
                    padding: space[3],
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: c.line,
                    backgroundColor: c.surface,
                  }}
                >
                  <Icon name={on ? 'checkbox' : 'square-outline'} size={24} color={on ? c.yapi : c.inkMuted} />
                  <Avatar name={p.user.displayName} url={p.user.avatarUrl} size={40} />
                  <View style={{ flex: 1 }}>
                    <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
                      {p.user.displayName}
                    </Text>
                    <Text style={{ color: c.inkMuted, fontSize: 13 }} numberOfLines={1}>
                      {p.reason}
                    </Text>
                  </View>
                </Pressable>
              );
            })
          ) : (
            <Text style={{ color: c.inkMuted }}>{t('onboarding.follow.empty')}</Text>
          )}
          <Button label={t('onboarding.continue')} disabled={busy} onPress={() => void follow(false)} />
          {people?.length ? <Button label={t('onboarding.skip')} variant="ghost" disabled={busy} onPress={() => void follow(true)} /> : null}
        </>
      ) : (
        <>
          <Title>{t('friends.title')}</Title>
          <FriendsFinder onChecked={setFriends} />
          <Button label={t('onboarding.finish')} disabled={busy} onPress={() => void finish()} />
        </>
      )}
    </ScrollView>
  );
}
