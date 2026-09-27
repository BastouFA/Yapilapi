import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { OnboardingStep } from '../../../packages/api-client/src/index';
import { SUPPORTED_LOCALES, type MessageKey } from '../../../packages/shared/src/i18n';
import { languageName, TRANSLATION_LANGUAGES } from '../../../packages/shared/src/translation';
import type { Community, PublicUser } from '../../../packages/shared/src/types';
import { client, errorMessage, mediaUrl } from '../lib/api';
import { FriendsFinder } from '../lib/friends';
import { useT } from '../lib/i18n';
import { pickOne, uploadPicked } from '../lib/media';
import { registerForPush } from '../lib/push';
import { useSession } from '../lib/session';
import { radius, space } from '../lib/theme';
import { Avatar, Button, Field, Icon, Notice, Skeleton, Title, useColors, userText } from '../lib/ui';

type Suggestion = { user: PublicUser; reason: string };
/** How many suggested creators start ticked. */
const PRESELECTED = 5;
/** Communities offered on the follow step. */
const COMMUNITIES = 6;

const STEPS = ['language', 'interests', 'follow', 'friends', 'profile', 'notifications'] as const;
type StepId = (typeof STEPS)[number];
const TITLES: Record<StepId, MessageKey> = {
  language: 'm.onb.language.title',
  interests: 'onboarding.interests.title',
  follow: 'm.onb.follow.title',
  friends: 'friends.title',
  profile: 'm.onb.profile.title',
  notifications: 'm.onb.push.title',
};

/** Where someone got to, kept on the phone so onboarding picks up there after the app closes (or reloads for Arabic). */
type Saved = { step: number; log: OnboardingStep[]; picked: string[] };
const storeKey = (userId: string) => `ypl_onboarding_${userId.replace(/[^A-Za-z0-9_.-]/g, '')}`;

/**
 * Six short steps for a new account, each one skippable, with progress at the top and a way back:
 * the app's language, interests (topics and what's trending), people and communities to follow (the
 * top five people ticked), friends from contacts or an invite link, a profile photo and name, then
 * notifications with what they are for. Where you got to is saved, so closing the app doesn't
 * start it over.
 */
export default function Onboarding() {
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const { me, refresh } = useSession();
  const scroll = useRef<ScrollView>(null);
  const [restored, setRestored] = useState(false);
  const [step, setStep] = useState(0);
  const [log, setLog] = useState<OnboardingStep[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pick up where this person left off.
  useEffect(() => {
    if (!me) return;
    void SecureStore.getItemAsync(storeKey(me.id))
      .then((raw) => {
        if (!raw) return;
        const s = JSON.parse(raw) as Saved;
        if (Number.isInteger(s.step)) setStep(Math.min(Math.max(0, s.step), STEPS.length - 1));
        if (Array.isArray(s.log)) setLog(s.log);
        if (Array.isArray(s.picked)) setPicked(new Set(s.picked));
      })
      .catch(() => {})
      .finally(() => setRestored(true));
  }, [me?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!me || !restored) return;
    const saved: Saved = { step, log, picked: [...picked] };
    void SecureStore.setItemAsync(storeKey(me.id), JSON.stringify(saved)).catch(() => {});
  }, [me, restored, step, log, picked]);

  const id = STEPS[step]!;
  // New step: back to the top, and screen readers hear where they are.
  useEffect(() => {
    if (!restored) return;
    scroll.current?.scrollTo({ y: 0, animated: false });
    AccessibilityInfo.announceForAccessibility(`${t('onboarding.step', { step: step + 1, total: STEPS.length })}. ${t(TITLES[id])}`);
  }, [step, restored]); // eslint-disable-line react-hooks/exhaustive-deps

  const record = (s: OnboardingStep) => setLog((l) => [...l.filter((x) => x.step !== s.step), s]);
  // A problem from one step (some follows that didn't go through) stays readable on the next.
  const next = () => setStep((s) => Math.min(s + 1, STEPS.length - 1));
  const back = () => {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  };

  async function finish() {
    if (!me) return;
    setBusy(true);
    setError(null);
    try {
      // Only interests, follow and friends are counted (the analytics event knows those three).
      const steps = (['interests', 'follow', 'friends'] as const).map((s) => log.find((x) => x.step === s) ?? { step: s, skipped: true, count: 0 });
      await (await client()).me.completeOnboarding({ platform: 'mobile', steps });
      await SecureStore.deleteItemAsync(storeKey(me.id)).catch(() => {});
      await refresh();
      router.replace('/');
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  if (!me || !restored)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={c.yapi} accessibilityLabel={t('common.loading')} />
      </View>
    );

  return (
    <ScrollView
      ref={scroll}
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], paddingTop: insets.top + space[2], paddingBottom: insets.bottom + space[8], gap: space[4] }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ gap: space[2] }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 44 }}>
          {step > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('m.common.back')}
              onPress={back}
              hitSlop={8}
              style={{ width: 44, height: 44, justifyContent: 'center' }}
            >
              <Icon name="chevron-back" size={24} color={c.ink} directional />
            </Pressable>
          ) : null}
          <Text style={{ color: c.inkMuted, fontSize: 13, flex: 1 }}>{t('onboarding.step', { step: step + 1, total: STEPS.length })}</Text>
        </View>
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={t('m.onb.progress')}
          accessibilityValue={{ min: 1, max: STEPS.length, now: step + 1 }}
          style={{ flexDirection: 'row', gap: 4 }}
        >
          {STEPS.map((s, i) => (
            <View key={s} style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: i <= step ? c.yapi : c.surfaceSunken }} />
          ))}
        </View>
      </View>
      {error ? <Notice tone="danger">{error}</Notice> : null}

      {id === 'language' ? (
        <LanguageStep onNext={next} setError={setError} />
      ) : id === 'interests' ? (
        <InterestsStep picked={picked} setPicked={setPicked} record={record} onNext={next} setError={setError} />
      ) : id === 'follow' ? (
        <FollowStep record={record} onNext={next} setError={setError} />
      ) : id === 'friends' ? (
        <>
          <Title>{t('friends.title')}</Title>
          <FriendsFinder onChecked={(r) => record({ step: 'friends', skipped: false, count: r.found })} />
          <Button
            label={t('onboarding.continue')}
            onPress={() => {
              if (!log.some((x) => x.step === 'friends')) record({ step: 'friends', skipped: true, count: 0 });
              next();
            }}
          />
        </>
      ) : id === 'profile' ? (
        <ProfileStep onNext={next} setError={setError} />
      ) : (
        <NotificationsStep busy={busy} onFinish={() => void finish()} />
      )}
    </ScrollView>
  );
}

type StepProps = { onNext: () => void; setError: (e: string | null) => void };

/** The app's language: the eight the app speaks, each in its own name, with the current one ticked. */
function LanguageStep({ onNext, setError }: StepProps) {
  const c = useColors();
  const { t, lang, locale } = useT();
  const { refresh } = useSession();
  const [saving, setSaving] = useState<string | null>(null);

  async function choose(code: string) {
    if (code === lang || saving) return;
    setSaving(code);
    setError(null);
    try {
      await (await client()).me.updateProfile({ locale: code });
      // The session's locale changes the app's language (and, for Arabic, its direction).
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(null);
    }
  }

  return (
    <>
      <Title sub={t('m.onb.language.body')}>{t('m.onb.language.title')}</Title>
      <View accessibilityRole="radiogroup" style={{ gap: space[2] }}>
        {SUPPORTED_LOCALES.map((code) => {
          const on = code === lang;
          const autonym = TRANSLATION_LANGUAGES.find((l) => l.code === code)?.autonym ?? code;
          const local = languageName(code, locale);
          return (
            <Pressable
              key={code}
              accessibilityRole="radio"
              accessibilityState={{ checked: on, busy: saving === code }}
              accessibilityLanguage={code}
              accessibilityLabel={local.toLowerCase() === autonym.toLowerCase() ? autonym : `${autonym}, ${local}`}
              onPress={() => void choose(code)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space[3],
                minHeight: 52,
                paddingHorizontal: space[4],
                borderRadius: radius.md,
                borderWidth: on ? 2 : 1,
                borderColor: on ? c.yapi : c.line,
                backgroundColor: c.surface,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.ink, fontWeight: '700', fontSize: 16 }}>{autonym}</Text>
                {local.toLowerCase() !== autonym.toLowerCase() ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{local}</Text> : null}
              </View>
              {saving === code ? (
                <ActivityIndicator size="small" color={c.yapi} />
              ) : (
                <Icon name={on ? 'radio-button-on' : 'radio-button-off'} size={22} color={on ? c.yapi : c.inkMuted} />
              )}
            </Pressable>
          );
        })}
      </View>
      <Button label={t('onboarding.continue')} disabled={!!saving} onPress={onNext} />
    </>
  );
}

function InterestsStep({
  picked,
  setPicked,
  record,
  onNext,
  setError,
}: StepProps & { picked: Set<string>; setPicked: (s: Set<string>) => void; record: (s: OnboardingStep) => void }) {
  const c = useColors();
  const { t } = useT();
  const [topics, setTopics] = useState<{ slug: string; name: string }[] | null>(null);
  const [trending, setTrending] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

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

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (picked.size) await (await client()).me.setInterests([...picked]);
      record({ step: 'interests', skipped: picked.size === 0, count: picked.size });
      onNext();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const chip = (id: string, label: string) => {
    const on = picked.has(id);
    return (
      <Pressable
        key={id}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: on }}
        onPress={() => {
          const n = new Set(picked);
          if (on) n.delete(id);
          else n.add(id);
          setPicked(n);
        }}
        style={{
          minHeight: 44,
          paddingHorizontal: space[4],
          borderRadius: radius.full,
          borderWidth: 1,
          borderColor: on ? c.yapi : c.lineStrong,
          backgroundColor: on ? c.yapi : c.surface,
          justifyContent: 'center',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {on ? <Icon name="checkmark" size={16} color={c.onYapi} /> : null}
        <Text style={[{ color: on ? c.onYapi : c.ink, fontWeight: '600', fontSize: 14 }, userText]}>{label}</Text>
      </Pressable>
    );
  };

  return (
    <>
      <Title sub={t('onboarding.interests.body')}>{t('onboarding.interests.title')}</Title>
      {topics === null ? (
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={t('common.loading')}
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}
        >
          {[90, 120, 70, 110, 84, 132, 96, 76, 118].map((w, i) => (
            <Skeleton key={i} width={w} height={44} radius={radius.full} />
          ))}
        </View>
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
        onPress={() => save()}
      />
      <Button
        label={t('onboarding.skip')}
        variant="ghost"
        disabled={busy}
        onPress={() => {
          record({ step: 'interests', skipped: true, count: 0 });
          onNext();
        }}
      />
    </>
  );
}

/** People who post about what you picked (the top five ticked) and communities to join. */
function FollowStep({ record, onNext, setError }: StepProps & { record: (s: OnboardingStep) => void }) {
  const c = useColors();
  const { t, number } = useT();
  const [people, setPeople] = useState<Suggestion[] | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [communities, setCommunities] = useState<Community[]>([]);
  const [joining, setJoining] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const api = await client();
      const [creators, discover] = await Promise.all([
        api.me.suggestions({ kind: 'creators', limit: 12 }).catch(() => ({ items: [] as Suggestion[] })),
        api.communities.list('discover').catch(() => ({ items: [] as Community[] })),
      ]);
      let items: Suggestion[] = creators.items;
      if (items.length < PRESELECTED) {
        const more = (await api.me.suggestions().catch(() => ({ items: [] as Suggestion[] }))).items.filter((s) => !items.some((i) => i.user.id === s.user.id));
        items = [...items, ...more].slice(0, 12);
      }
      setPeople(items);
      setTicked(new Set(items.slice(0, PRESELECTED).map((s) => s.user.id)));
      setCommunities(discover.items.filter((x) => !x.myRole).slice(0, COMMUNITIES));
    })();
  }, []);

  const flip = (set: Set<string>, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  };

  async function go(skip: boolean) {
    setBusy(true);
    setError(null);
    const api = await client();
    const ids = skip ? [] : [...ticked];
    const slugs = skip ? [] : communities.filter((x) => joining.has(x.id)).map((x) => x.slug);
    const [followed, joined] = await Promise.all([
      Promise.allSettled(ids.map((id) => api.users.follow(id))),
      Promise.allSettled(slugs.map((slug) => api.communities.join(slug))),
    ]);
    const ok = followed.filter((r) => r.status === 'fulfilled').length;
    if (ok < ids.length || joined.some((r) => r.status === 'rejected')) setError(t('m.onb.follow.partial'));
    record({ step: 'follow', skipped: skip || !ids.length, count: ok });
    setBusy(false);
    onNext();
  }

  const box = (on: boolean) => <Icon name={on ? 'checkbox' : 'square-outline'} size={24} color={on ? c.yapi : c.inkMuted} />;
  const rowStyle = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: space[3],
    padding: space[3],
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.line,
    backgroundColor: c.surface,
  };

  return (
    <>
      <Title sub={people?.length ? t('onboarding.follow.body') : undefined}>{t('m.onb.follow.title')}</Title>
      {people === null ? (
        <View accessible accessibilityRole="progressbar" accessibilityLabel={t('common.loading')} style={{ gap: space[2] }}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={rowStyle}>
              <Skeleton width={24} height={24} radius={6} />
              <Skeleton width={40} height={40} radius={20} />
              <View style={{ flex: 1, gap: 6 }}>
                <Skeleton width="55%" height={12} />
                <Skeleton width="40%" height={10} />
              </View>
            </View>
          ))}
        </View>
      ) : people.length ? (
        <>
          <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>
            {t('m.onb.follow.people')}
          </Text>
          {people.map((p) => {
            const on = ticked.has(p.user.id);
            return (
              <Pressable
                key={p.user.id}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={p.reason ? `${p.user.displayName}, ${p.reason}` : p.user.displayName}
                onPress={() => setTicked((s) => flip(s, p.user.id))}
                style={rowStyle}
              >
                {box(on)}
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
          })}
        </>
      ) : (
        <Text style={{ color: c.inkMuted }}>{t('onboarding.follow.empty')}</Text>
      )}
      {communities.length ? (
        <>
          <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700', fontSize: 15, marginTop: space[2] }}>
            {t('m.onb.follow.communities')}
          </Text>
          {communities.map((x) => {
            const on = joining.has(x.id);
            const members = t('m.onb.follow.members', { count: number(x.memberCount, { notation: 'compact' }) });
            return (
              <Pressable
                key={x.id}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={`${x.name}, ${members}`}
                onPress={() => setJoining((s) => flip(s, x.id))}
                style={rowStyle}
              >
                {box(on)}
                <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: c.yapiSoft, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="people" size={20} color={c.yapi} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
                    {x.name}
                  </Text>
                  <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
                    {x.description ? `${members} · ${x.description}` : members}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </>
      ) : null}
      <Button label={t('onboarding.continue')} disabled={busy || people === null} onPress={() => go(false)} />
      <Button label={t('onboarding.skip')} variant="ghost" disabled={busy} onPress={() => go(true)} />
    </>
  );
}

/** A profile photo and the name people see. */
function ProfileStep({ onNext, setError }: StepProps) {
  const c = useColors();
  const { t } = useT();
  const { me, refresh } = useSession();
  const [name, setName] = useState(me?.displayName ?? '');
  const [photo, setPhoto] = useState<{ local: string; progress: number } | null>(null);
  const [busy, setBusy] = useState(false);

  async function changePhoto() {
    setError(null);
    const asset = await pickOne(['images']).catch((e: unknown) => {
      setError(errorMessage(e));
      return null;
    });
    if (asset === 'denied') return setError(t('m.create.photosPermission'));
    if (!asset) return;
    setPhoto({ local: asset.uri, progress: 0 });
    try {
      const m = await uploadPicked(asset, (progress) => setPhoto({ local: asset.uri, progress }));
      await (await client()).me.updateProfile({ avatarUrl: mediaUrl(m.url) });
      await refresh();
      AccessibilityInfo.announceForAccessibility(t('m.onb.profile.photoSaved'));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPhoto(null);
    }
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) return setError(t('m.auth.nameNeeded'));
    setBusy(true);
    setError(null);
    try {
      if (trimmed !== me?.displayName) {
        await (await client()).me.updateProfile({ displayName: trimmed });
        await refresh();
      }
      onNext();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const size = 112;
  return (
    <>
      <Title sub={t('m.onb.profile.body')}>{t('m.onb.profile.title')}</Title>
      <View style={{ alignItems: 'center', gap: space[3] }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={me?.avatarUrl ? t('m.onb.profile.changePhoto') : t('m.onb.profile.addPhoto')}
          accessibilityState={{ busy: !!photo }}
          disabled={!!photo}
          onPress={() => void changePhoto()}
          style={{ width: size, height: size }}
        >
          {photo ? (
            <Image source={{ uri: photo.local }} style={{ width: size, height: size, borderRadius: size / 2, opacity: 0.6 }} />
          ) : (
            <Avatar name={name || me?.displayName || ''} url={me?.avatarUrl} size={size} />
          )}
          <View
            style={{
              position: 'absolute',
              end: 0,
              bottom: 0,
              width: 36,
              height: 36,
              borderRadius: 18,
              backgroundColor: c.yapi,
              borderWidth: 3,
              borderColor: c.ground,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {photo ? <ActivityIndicator size="small" color={c.onYapi} /> : <Icon name="camera" size={16} color={c.onYapi} />}
          </View>
        </Pressable>
        <Button
          size="sm"
          variant="ghost"
          label={me?.avatarUrl ? t('m.onb.profile.changePhoto') : t('m.onb.profile.addPhoto')}
          disabled={!!photo}
          onPress={() => changePhoto()}
        />
      </View>
      <Field label={t('auth.displayName')} value={name} onChangeText={setName} maxLength={60} autoComplete="name" hint={t('m.onb.profile.nameHint')} />
      <Button label={t('onboarding.continue')} disabled={busy || !!photo} onPress={() => save()} />
      <Button label={t('onboarding.skip')} variant="ghost" disabled={busy || !!photo} onPress={onNext} />
    </>
  );
}

/** Notifications, with what they are for, before the system asks. Not now is as easy as yes. */
function NotificationsStep({ busy, onFinish }: { busy: boolean; onFinish: () => void }) {
  const c = useColors();
  const { t } = useT();
  const [state, setState] = useState<'idle' | 'asking' | 'registered' | 'denied' | 'unavailable'>('idle');

  const reasons: { icon: 'chatbubble-outline' | 'call-outline' | 'people-outline'; text: MessageKey }[] = [
    { icon: 'chatbubble-outline', text: 'm.onb.push.messages' },
    { icon: 'call-outline', text: 'm.onb.push.calls' },
    { icon: 'people-outline', text: 'm.onb.push.people' },
  ];

  const note =
    state === 'registered' ? t('m.push.on') : state === 'denied' ? t('m.onb.push.denied') : state === 'unavailable' ? t('m.onb.push.unavailable') : null;

  return (
    <>
      <Title sub={t('m.onb.push.body')}>{t('m.onb.push.title')}</Title>
      <View style={{ gap: space[3] }}>
        {reasons.map((r) => (
          <View key={r.text} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
            <View style={{ width: 40, height: 40, borderRadius: 14, backgroundColor: c.yapiSoft, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={r.icon} size={20} color={c.yapi} />
            </View>
            <Text style={{ color: c.ink, flex: 1, fontSize: 15, lineHeight: 21 }}>{t(r.text)}</Text>
          </View>
        ))}
      </View>
      <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.onb.push.control')}</Text>
      {note ? <Notice tone={state === 'registered' ? 'info' : 'warn'}>{note}</Notice> : null}
      {state === 'registered' || state === 'denied' || state === 'unavailable' ? (
        <Button label={t('onboarding.finish')} disabled={busy} onPress={onFinish} />
      ) : (
        <>
          <Button
            label={t('m.push.enable')}
            icon="notifications-outline"
            disabled={state === 'asking' || busy}
            onPress={async () => {
              setState('asking');
              const r = await registerForPush().catch(() => 'unavailable' as const);
              setState(r);
              AccessibilityInfo.announceForAccessibility(
                r === 'registered' ? t('m.push.on') : r === 'denied' ? t('m.onb.push.denied') : t('m.onb.push.unavailable'),
              );
            }}
          />
          <Button label={t('m.common.notNow')} variant="ghost" disabled={state === 'asking' || busy} onPress={onFinish} />
        </>
      )}
    </>
  );
}
