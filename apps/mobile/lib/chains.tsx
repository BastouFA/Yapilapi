import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from 'react-native';
import { CHAIN_RULES, FAIR_START, type ChainJoin } from '../../../packages/shared/src/constants';
import { fairStartLines, type Chain, type ChainRef, type FairStart } from '../../../packages/shared/src/pass-the-mic';
import type { Post, PublicUser } from '../../../packages/shared/src/types';
import { client, errorMessage, mediaUrl } from './api';
import { SectionHeader } from './chips';
import { Chips } from './circles';
import { useFlag } from './flags';
import { useT } from './i18n';
import { radius, space } from './theme';
import { Avatar, BottomSheet, Button, Card, Field, Icon, Notice, useColors, userText } from './ui';

/**
 * Pass the Mic on the phone (docs/product/pass-the-mic.md): what Reels, Create, the chain's page,
 * Wander and a reel's insights share. The shared rules and texts are in
 * packages/shared/src/pass-the-mic.ts.
 */

/** Take the mic: the reel camera, with the chain's prompt; Create then keeps its sound and posts the reel as the next link. */
export function takeTheMic(chainId: string) {
  router.push({ pathname: '/camera', params: { mode: 'reel', chain: chainId } });
}

export const openChain = (chainId: string) => router.push({ pathname: '/chain/[id]', params: { id: chainId } });

/** Whether a reel of yours could start a chain: posted (not a draft), to everyone, followers or friends, outside a community. */
export const canStartChain = (p: Post) =>
  p.format === 'reel' && !p.status && !p.chain && !p.community && !p.echoOf && ['public', 'followers', 'friends'].includes(p.visibility);

/** A chain just started from a reel, as that reel's Post.chain (it is the first link). */
export function chainRefFrom(chain: Chain): ChainRef {
  return {
    id: chain.id,
    prompt: chain.prompt,
    position: 1,
    total: Math.max(1, chain.counts.links),
    people: chain.counts.people,
    countries: chain.counts.countries,
    starter: chain.starter,
    canJoin: chain.viewer.canJoin,
    isStarter: chain.viewer.isStarter,
    closed: chain.closed,
  };
}

/** Who can take the mic, as choices. Starting a chain offers everyone or people you follow (nothing chosen: your account's default). */
export function JoinChoice({
  value,
  onChange,
  withNobody,
}: {
  value: ChainJoin | null;
  onChange: (v: ChainJoin | null) => void;
  /** Also "Nobody, the chain is closed" (the starter's settings). */
  withNobody?: boolean;
}) {
  const c = useColors();
  const { t } = useT();
  const options = (['everyone', 'following', ...(withNobody ? ['nobody' as const] : [])] as const).map((id) => ({ id, label: t(`mic.who.${id}`) }));
  return (
    <View style={{ gap: space[2] }}>
      <Text style={{ color: c.ink, fontWeight: '600' }}>{t('mic.who')}</Text>
      <Chips label={t('mic.who')} options={options} value={value} onChange={onChange} clearable={!withNobody} />
    </View>
  );
}

/** Start a chain with one of your reels already posted: a prompt and who can take the mic. */
export function StartChainSheet({ post, onClose, onStarted }: { post: Post | null; onClose: () => void; onStarted: (chain: Chain) => void }) {
  const c = useColors();
  const { t } = useT();
  const [prompt, setPrompt] = useState('');
  const [join, setJoin] = useState<ChainJoin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!post) return;
    setPrompt('');
    setJoin(null);
    setError(null);
  }, [post]);
  const start = async () => {
    if (!post || !prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await (await client()).chains.start(post.id, prompt.trim(), join ?? undefined);
      onStarted(r.chain);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <BottomSheet visible={!!post} title={t('mic.start')} onClose={onClose}>
      <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>{t('mic.start.hint')}</Text>
      <Field
        label={t('mic.prompt')}
        placeholder={t('mic.prompt.placeholder')}
        value={prompt}
        onChangeText={setPrompt}
        maxLength={CHAIN_RULES.promptMax}
        returnKeyType="done"
      />
      <JoinChoice value={join} onChange={setJoin} />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: space[2] }}>
        <Button label={t('common.cancel')} variant="ghost" onPress={onClose} />
        <Button label={t('mic.start')} icon="mic-outline" disabled={busy || !prompt.trim()} onPress={start} />
      </View>
    </BottomSheet>
  );
}

type Suggestion = { user: PublicUser; relation: 'friend' | 'following' | null };

/**
 * Pass the mic: invite up to CHAIN_RULES.passesAtOnce people you follow or are friends with to add
 * the next reel, like apps/web/components/PassTheMic.tsx. Before typing it offers your friends,
 * people you follow and recent chats; each letter narrows it down. Anyone else is shown, with the
 * reason, but can't be ticked. The server also skips anyone who can't take the mic, without saying
 * who: the count tells how many it reached.
 */
export function PassMicSheet({ chainId, onClose, onPassed }: { chainId: string | null; onClose: () => void; onPassed: (passed: number) => void }) {
  const c = useColors();
  const { t } = useT();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [picked, setPicked] = useState<Suggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const req = useRef(0);
  const full = picked.length >= CHAIN_RULES.passesAtOnce;
  useEffect(() => {
    if (!chainId) return;
    setQ('');
    setPicked([]);
    setError(null);
  }, [chainId]);
  useEffect(() => {
    if (!chainId) return;
    const n = ++req.current;
    const timer = setTimeout(
      () =>
        void client()
          .then((api) => api.people.suggest(q.trim().replace(/^@/, ''), 12))
          .then(
            (r) => n === req.current && setItems(r.items),
            () => n === req.current && setItems((cur) => cur ?? []),
          ),
      q ? 150 : 0,
    );
    return () => clearTimeout(timer);
  }, [chainId, q]);
  // The people ticked stay at the top while the search changes.
  const rows: Suggestion[] = [...picked, ...(items ?? []).filter((s) => !picked.some((p) => p.user.id === s.user.id))];
  const send = async () => {
    if (!chainId || !picked.length) return;
    setBusy(true);
    setError(null);
    try {
      const r = await (
        await client()
      ).chains.pass(
        chainId,
        picked.map((p) => p.user.id),
      );
      onPassed(r.passed);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <BottomSheet visible={!!chainId} title={t('mic.pass')} subtitle={t('mic.pass.hint')} onClose={onClose}>
      <Field
        label={t('m.group.addPeople')}
        placeholder={t('m.group.placeholder')}
        value={q}
        onChangeText={setQ}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        hint={full ? t('people.max', { count: CHAIN_RULES.passesAtOnce }) : undefined}
      />
      {items === null ? (
        <ActivityIndicator color={c.yapi} accessibilityLabel={t('common.loading')} style={{ paddingVertical: space[3] }} />
      ) : !rows.length ? (
        <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, lineHeight: 20 }}>
          {q.trim() ? t('m.group.noMatch', { query: q.trim() }) : t('mic.pass.followingOnly')}
        </Text>
      ) : (
        <View style={{ gap: space[1] }}>
          {rows.map((s) => {
            const on = picked.some((p) => p.user.id === s.user.id);
            const allowed = s.relation !== null;
            const disabled = !on && (!allowed || full);
            const meta = [
              `@${s.user.username}`,
              s.relation === 'friend' ? t('m.group.friend') : s.relation === 'following' ? t('m.group.following') : t('mic.pass.followingOnly'),
            ].join(' · ');
            return (
              <Pressable
                key={s.user.id}
                accessibilityRole="checkbox"
                accessibilityLabel={`${s.user.displayName}, ${meta}`}
                accessibilityState={{ checked: on, disabled }}
                disabled={disabled}
                onPress={() => setPicked((cur) => (on ? cur.filter((p) => p.user.id !== s.user.id) : [...cur, s]))}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space[3],
                  minHeight: 52,
                  paddingHorizontal: space[2],
                  borderRadius: radius.md,
                  opacity: disabled ? 0.5 : 1,
                  backgroundColor: pressed ? c.surfaceSunken : 'transparent',
                })}
              >
                <Avatar name={s.user.displayName} url={s.user.avatarUrl} size={36} />
                <View style={{ flex: 1 }}>
                  <Text style={[{ color: c.ink, fontWeight: '600', fontSize: 15 }, userText]} numberOfLines={1}>
                    {s.user.displayName}
                  </Text>
                  <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={2}>
                    {meta}
                  </Text>
                </View>
                {allowed ? <Icon name={on ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={on ? c.yapi : c.inkMuted} /> : null}
              </Pressable>
            );
          })}
        </View>
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: space[2] }}>
        <Button label={t('common.cancel')} variant="ghost" onPress={onClose} />
        <Button label={t('mic.pass')} icon="mic-outline" disabled={busy || !picked.length} onPress={send} />
      </View>
    </BottomSheet>
  );
}

/** The starter: who can take the mic now ('nobody' closes the chain; its reels stay). */
export function ChainWhoSheet({ chainId, onClose, onSaved }: { chainId: string | null; onClose: () => void; onSaved: (chain: Chain) => void }) {
  const c = useColors();
  const { t } = useT();
  const [value, setValue] = useState<ChainJoin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!chainId) return;
    let live = true;
    setValue(null);
    setError(null);
    void client()
      .then((api) => api.chains.get(chainId))
      .then(
        (r) => live && setValue(r.chain.whoCanJoin),
        (e) => live && setError(errorMessage(e)),
      );
    return () => {
      live = false;
    };
  }, [chainId]);
  const save = async () => {
    if (!chainId || !value) return;
    setBusy(true);
    setError(null);
    try {
      const r = await (await client()).chains.edit(chainId, { whoCanJoin: value });
      onSaved(r.chain);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <BottomSheet visible={!!chainId} title={t('mic.who')} onClose={onClose}>
      {value === null && !error ? <Text style={{ color: c.inkMuted }}>{t('common.loading')}</Text> : null}
      {value !== null ? <JoinChoice value={value} onChange={(v) => v && setValue(v)} withNobody /> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: space[2] }}>
        <Button label={t('common.cancel')} variant="ghost" onPress={onClose} />
        <Button label={t('common.save')} disabled={busy || !value} onPress={save} />
      </View>
    </BottomSheet>
  );
}

/** "12 reels · 9 people · 4 countries", the countries left out when nobody said where they are. */
export function useChainCounts() {
  const { tp, number } = useT();
  return (counts: Chain['counts']) =>
    [
      tp('mic.links', counts.links, { count: number(counts.links) }),
      tp('mic.people', counts.people, { count: number(counts.people) }),
      ...(counts.countries ? [tp('mic.countries', counts.countries, { count: number(counts.countries) })] : []),
    ].join(' · ');
}

/** Wander's Chains shelf: chains with new reels this week, the busiest first. Hidden when there are none or the feature is off. */
export function ChainShelf({ refreshKey }: { refreshKey?: number }) {
  const c = useColors();
  const { t } = useT();
  const on = useFlag('PASS_THE_MIC');
  const countsText = useChainCounts();
  const [items, setItems] = useState<Chain[]>([]);
  useEffect(() => {
    if (!on) return;
    let live = true;
    void client()
      .then((api) => api.chains.active())
      .then(
        (r) => live && setItems(r.items),
        () => {},
      );
    return () => {
      live = false;
    };
  }, [on, refreshKey]);
  if (!on || !items.length) return null;
  return (
    <View style={{ gap: space[2] }}>
      <SectionHeader title={t('mic.shelf')} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[3] }}>
        {items.map((ch) => {
          const poster = ch.cover ? (ch.cover.variants?.thumb ?? ch.cover.posterUrl) : null;
          const counts = countsText(ch.counts);
          return (
            <Pressable
              key={ch.id}
              accessibilityRole="link"
              accessibilityLabel={`${ch.prompt}. ${t('mic.startedBy', { name: ch.starter.displayName })}. ${counts}`}
              onPress={() => openChain(ch.id)}
              style={({ pressed }) => ({ width: 148, gap: space[1], opacity: pressed ? 0.85 : 1 })}
            >
              <View style={{ width: 148, aspectRatio: 9 / 16, borderRadius: radius.md, overflow: 'hidden', backgroundColor: '#05060B' }}>
                {poster ? (
                  <Image source={{ uri: mediaUrl(poster) }} style={{ width: '100%', height: '100%' }} resizeMode="cover" accessibilityIgnoresInvertColors />
                ) : (
                  <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="mic-outline" size={32} color="#FFFFFF" />
                  </View>
                )}
              </View>
              <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 14, lineHeight: 19 }, userText]} numberOfLines={2}>
                {ch.prompt}
              </Text>
              <Text style={{ color: c.inkMuted, fontSize: 12, lineHeight: 16 }} numberOfLines={2}>
                {counts}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/**
 * A reel's (or Yap's) fair start, on its insights: while it runs, how many people it reached of the target (a
 * progress bar); when it's over, what those people did.
 */
export function FairStartCard({ fairStart: f, format = 'reel' }: { fairStart: FairStart; format?: string }) {
  const c = useColors();
  const { t, tp, number } = useT();
  const reached = Math.min(f.reached, f.target);
  const share = f.target ? reached / f.target : 0;
  const progress = t('fair.progress', { reached: number(f.reached), target: number(f.target) });
  return (
    <Card style={{ gap: space[2] }}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
        {t('fair.title')}
      </Text>
      {f.status === 'active' ? (
        <>
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel={t('fair.title')}
            accessibilityValue={{ min: 0, max: f.target, now: reached, text: progress }}
            style={{ height: 8, borderRadius: 4, backgroundColor: c.surfaceSunken, overflow: 'hidden' }}
          >
            <View style={{ width: `${Math.round(share * 100)}%`, height: '100%', borderRadius: 4, backgroundColor: c.yapi }} />
          </View>
          <Text style={{ color: c.ink, fontWeight: '600' }} importantForAccessibility="no" accessibilityElementsHidden>
            {progress}
          </Text>
          <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>{t('fair.promise', { target: number(f.target) })}</Text>
          {f.slowed ? <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>{t('fair.slowed')}</Text> : null}
        </>
      ) : (
        <Text style={{ color: c.ink, lineHeight: 22 }}>{fairStartLines(f.report, tp, (n) => number(n), format).join(' · ')}</Text>
      )}
    </Card>
  );
}

/** "We'll show it to up to 1,000 people.", in Create while making a reel that will get a fair start. */
export function FairStartPromise({ active }: { active: boolean }) {
  const c = useColors();
  const { t, number } = useT();
  const on = useFlag('FAIR_START');
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    if (!on || !active) return;
    let live = true;
    void client()
      .then((api) => api.fairStart.offered())
      .then(
        (r) => live && setOffered(r.offered),
        () => {},
      );
    return () => {
      live = false;
    };
  }, [on, active]);
  if (!on || !active || !offered) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
      <Icon name="people-outline" size={18} color={c.inkMuted} />
      <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20, flexShrink: 1 }}>{t('fair.promise', { target: number(FAIR_START.target) })}</Text>
    </View>
  );
}
