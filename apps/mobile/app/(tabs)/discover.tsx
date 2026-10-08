import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { formatMoney, type MessageKey } from '../../../../packages/shared/src/i18n-core';
import { formatList } from '../../../../packages/shared/src/feed-reasons';
import { normalizeTag } from '../../../../packages/shared/src/hashtags';
import type { Community, EventItem, Post, PublicUser } from '../../../../packages/shared/src/types';
import type { TrendingTag } from '../../../../packages/api-client/src/index';
import { client, errorMessage } from '../../lib/api';
import { Chip, ChipRow, SectionHeader } from '../../lib/chips';
import { useT } from '../../lib/i18n';
import { PostCard } from '../../lib/post';
import { clearRecent, forgetSearch, readRecent, rememberSearch } from '../../lib/recent-searches';
import { radius, space } from '../../lib/theme';
import { Avatar, EmptyState, ErrorState, Icon, type IconName, Row, SkeletonList, useColors, useRefresh, userText, useTabBarSpace } from '../../lib/ui';

type Tab = 'all' | 'people' | 'topics' | 'posts' | 'communities' | 'events' | 'places';
const TABS: { id: Tab; label: MessageKey }[] = [
  { id: 'all', label: 'm.wander.all' },
  { id: 'people', label: 'discover.people' },
  { id: 'topics', label: 'm.wander.tags' },
  { id: 'posts', label: 'discover.posts' },
  { id: 'communities', label: 'discover.communities' },
  { id: 'events', label: 'discover.events' },
  { id: 'places', label: 'discover.places' },
];

type Place = { id: string; name: string; category: string | null; city: string | null };
/** A product in someone's shop: it opens there, by the seller's username. */
type FoundProduct = { id: string; title: string; priceCents: number; currency: string; sellerUsername?: string };
type Found = {
  people: PublicUser[];
  topics: { slug: string; name: string; posts: number }[];
  posts: Post[];
  communities: Pick<Community, 'id' | 'slug' | 'name' | 'description' | 'memberCount'>[];
  events: EventItem[];
  places: Place[];
  products: FoundProduct[];
};

/** What the search understood from a sentence, as words for "Showing events for tonight". */
type Intent = { types?: string[]; when?: { label: string }; placeCategory?: string; groupSize?: number };
const INTENT_TYPE: Record<string, MessageKey> = {
  people: 'discover.intent.type.people',
  posts: 'discover.intent.type.posts',
  communities: 'discover.intent.type.communities',
  events: 'discover.intent.type.events',
  places: 'discover.intent.type.places',
  businesses: 'discover.intent.type.businesses',
  products: 'discover.intent.type.products',
  topics: 'discover.intent.type.topics',
};
const INTENT_WHEN: Record<string, MessageKey> = {
  tonight: 'discover.intent.when.tonight',
  today: 'discover.intent.when.today',
  tomorrow: 'discover.intent.when.tomorrow',
  'this weekend': 'discover.intent.when.thisWeekend',
  'next week': 'discover.intent.when.nextWeek',
};

/** A single #tag typed on its own goes straight to its page, as on the web. */
const TAG_ONLY = /^#[\p{L}\p{M}\p{N}_]{2,40}$/u;
/** In "All", each kind shows this many before "See all". */
const PREVIEW = 4;

/**
 * Wander: search everything as you type (people, tags, posts, communities, events, places), with
 * filters, recent searches kept on this phone, and, before you type, trending tags, communities
 * to join and what's coming up. `?q=` (from a shared search link) starts a search.
 */
export default function Wander() {
  const c = useColors();
  const { t, tp, number, dateTime, locale } = useT();
  const bottom = useTabBarSpace();
  const params = useLocalSearchParams<{ q?: string }>();
  const input = useRef<TextInput>(null);
  const [q, setQ] = useState(params.q ?? '');
  const [tab, setTab] = useState<Tab>('all');
  const [found, setFound] = useState<Found | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [trending, setTrending] = useState<TrendingTag[] | null>(null);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);

  useEffect(() => {
    if (params.q) setQ(params.q);
  }, [params.q]);

  // Before you type: trending tags, communities and events (again on pull to refresh).
  const loadExplore = useCallback(async () => {
    const api = await client();
    await Promise.all([
      api.trending(10).then(
        (r) => setTrending(r.items),
        () => setTrending((cur) => cur ?? []),
      ),
      api.communities.list('discover').then(
        (r) => setCommunities(r.items.filter((x) => !x.myRole).slice(0, 5)),
        () => {},
      ),
      api.events.list('upcoming').then(
        (r) => setEvents(r.items.slice(0, 5)),
        () => {},
      ),
    ]);
  }, []);
  useEffect(() => {
    void readRecent().then(setRecent);
    void loadExplore().catch(() => setTrending((cur) => cur ?? []));
  }, [loadExplore]);
  // Try again (or pull to refresh) runs the same search again.
  const [attempt, setAttempt] = useState(0);

  // Results a moment after typing stops; a newer search replaces an older one still on its way.
  const term = q.trim();
  useEffect(() => {
    if (!term) {
      setFound(null);
      setIntent(null);
      setLoading(false);
      setError(null);
      return;
    }
    let current = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void client()
        .then((api) => api.search(term, tab))
        .then(
          (r) => {
            if (!current) return;
            const x = r.results as Record<string, unknown[] | undefined>;
            setFound({
              people: (x.people ?? []) as Found['people'],
              topics: (x.topics ?? []) as Found['topics'],
              posts: (x.posts ?? []) as Found['posts'],
              communities: (x.communities ?? []) as Found['communities'],
              events: (x.events ?? []) as Found['events'],
              places: (x.places ?? []) as Found['places'],
              // Products come with "All" (there's no tab of their own), when the API says whose shop they're in.
              products: ((x.products ?? []) as FoundProduct[]).filter((p) => !!p.sellerUsername),
            });
            setIntent((r.intent ?? null) as Intent | null);
            setError(null);
            setLoading(false);
          },
          (e) => current && (setError(errorMessage(e)), setLoading(false)),
        );
    }, 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [term, tab, attempt]);
  const refresh = useRefresh(() => (term ? setAttempt((a) => a + 1) : loadExplore()));

  const remember = useCallback(
    (value = term) => {
      if (value) void rememberSearch(value).then(setRecent);
    },
    [term],
  );

  const submit = (value = term) => {
    if (!value) return;
    remember(value);
    if (TAG_ONLY.test(value)) router.push(`/t/${encodeURIComponent(normalizeTag(value))}`);
  };

  const open = (href: string) => {
    remember();
    router.push(href as never);
  };

  const show = (k: Tab) => tab === 'all' || tab === k;
  const cut = <T,>(list: T[]) => (tab === 'all' ? list.slice(0, PREVIEW) : list);
  const seeAll = (k: Tab, count: number) =>
    tab === 'all' && count > PREVIEW
      ? { label: t('m.wander.seeAll'), a11yLabel: t('m.wander.seeAllOf', { kind: t(TABS.find((x) => x.id === k)!.label) }), onPress: () => setTab(k) }
      : undefined;
  const nothing = found && !Object.values(found).some((list) => list.length);
  // A sentence ("something to do tonight", "restaurants for six"): say how it was read.
  let showing = '';
  if (intent && (intent.when || intent.placeCategory || intent.groupSize)) {
    const words = (intent.types ?? []).map((x) => (INTENT_TYPE[x] ? t(INTENT_TYPE[x]) : x));
    const types = words.length ? formatList(words, locale, t) : t('discover.intent.results');
    const whenKey = intent.when ? INTENT_WHEN[intent.when.label] : undefined;
    const when = intent.when ? (whenKey ? t(whenKey) : intent.when.label) : '';
    if (intent.groupSize)
      showing = when
        ? tp('discover.intent.showingWhenGroup', intent.groupSize, { types, when })
        : tp('discover.intent.showingGroup', intent.groupSize, { types });
    else showing = when ? t('discover.intent.showingWhen', { types, when }) : t('discover.intent.showing', { types });
  }
  const shortcuts: { label: string; icon: IconName; href: string }[] = [
    { label: t('m.title.reels'), icon: 'film-outline', href: '/reels' },
    { label: t('events.title'), icon: 'calendar-outline', href: '/events' },
    { label: t('communities.title'), icon: 'people-circle-outline', href: '/communities' },
    { label: t('m.market.title'), icon: 'storefront-outline', href: '/market' },
    { label: t('m.title.assistant'), icon: 'sparkles-outline', href: '/assistant' },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: c.ground }}>
      <View style={{ paddingHorizontal: space[4], paddingTop: space[3], gap: space[2] }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space[2],
            minHeight: 48,
            borderRadius: radius.full,
            borderWidth: 1,
            borderColor: c.line,
            backgroundColor: c.surface,
            paddingStart: space[4],
            paddingEnd: space[1],
          }}
        >
          <Icon name="search" size={18} color={c.inkMuted} />
          <TextInput
            ref={input}
            accessibilityLabel={t('m.wander.label')}
            accessibilityRole="search"
            placeholder={t('discover.search')}
            placeholderTextColor={c.inkMuted}
            value={q}
            onChangeText={setQ}
            onSubmitEditing={() => submit()}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            maxLength={200}
            style={[{ flex: 1, color: c.ink, fontSize: 16, paddingVertical: space[2] }, userText]}
          />
          {loading ? <ActivityIndicator size="small" color={c.yapi} accessibilityLabel={t('m.discover.searching')} /> : null}
          {q ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('m.wander.clear')}
              onPress={() => {
                setQ('');
                input.current?.focus();
              }}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
            >
              <Icon name="close-circle" size={20} color={c.inkMuted} />
            </Pressable>
          ) : null}
        </View>
        {term ? (
          <ChipRow scroll tabs label={t('m.wander.show')}>
            {TABS.map((x) => (
              <Chip key={x.id} label={t(x.label)} selected={tab === x.id} onPress={() => setTab(x.id)} />
            ))}
          </ChipRow>
        ) : null}
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: bottom }}
        refreshControl={refresh}
      >
        {error ? <ErrorState message={error} onRetry={() => setAttempt((a) => a + 1)} /> : null}

        {!term ? (
          <>
            <ChipRow scroll>
              {shortcuts.map((s) => (
                <Chip key={s.href} label={s.label} icon={s.icon} onPress={() => router.push(s.href as never)} />
              ))}
            </ChipRow>

            {recent.length ? (
              <View style={{ gap: space[2] }}>
                <SectionHeader
                  title={t('m.wander.recent')}
                  action={{
                    label: t('m.wander.clearRecent'),
                    a11yLabel: t('m.wander.clearRecentLabel'),
                    onPress: () => {
                      setRecent([]);
                      void clearRecent();
                    },
                  }}
                />
                <ChipRow>
                  {recent.map((r) => (
                    <Chip
                      key={r}
                      label={r}
                      icon="time-outline"
                      a11yHint={t('m.wander.recentHint')}
                      onPress={() => {
                        setQ(r);
                        submit(r);
                      }}
                      onLongPress={() => void forgetSearch(r).then(setRecent)}
                    />
                  ))}
                </ChipRow>
              </View>
            ) : null}

            <View style={{ gap: space[2] }}>
              <SectionHeader title={t('m.wander.trending')} />
              {trending === null ? (
                <SkeletonList count={4} />
              ) : trending.length ? (
                <View style={{ gap: space[1] }}>
                  {trending.map((it, i) => {
                    const meta = t('trending.meta', {
                      posts: tp('trending.posts', it.posts, { number: number(it.posts, { notation: 'compact' }) }),
                      people: tp('trending.people', it.people, { number: number(it.people, { notation: 'compact' }) }),
                    });
                    return (
                      <Pressable
                        key={it.tag}
                        accessibilityRole="link"
                        accessibilityLabel={`#${it.tag}. ${meta}${it.rising ? `. ${t('trending.rising')}` : ''}`}
                        onPress={() => router.push(`/t/${encodeURIComponent(it.tag)}`)}
                        style={({ pressed }) => ({
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: space[3],
                          minHeight: 52,
                          paddingHorizontal: space[3],
                          borderRadius: radius.md,
                          backgroundColor: c.surface,
                          opacity: pressed ? 0.85 : 1,
                        })}
                      >
                        <Text style={{ color: c.inkMuted, fontWeight: '800', width: 20, textAlign: 'center' }}>{number(i + 1)}</Text>
                        <View style={{ flex: 1 }}>
                          <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 15 }, userText]} numberOfLines={1}>
                            #{it.tag}
                          </Text>
                          <Text style={{ color: c.inkMuted, fontSize: 13 }} numberOfLines={1}>
                            {meta}
                          </Text>
                        </View>
                        {it.rising ? (
                          <View
                            style={{
                              flexDirection: 'row',
                              alignItems: 'center',
                              gap: 4,
                              backgroundColor: c.saffronSoft,
                              borderRadius: radius.full,
                              paddingHorizontal: 8,
                              paddingVertical: 2,
                            }}
                          >
                            <Icon name="trending-up" size={14} color={c.ink} />
                            <Text style={{ color: c.ink, fontSize: 12, fontWeight: '700' }}>{t('trending.rising')}</Text>
                          </View>
                        ) : null}
                      </Pressable>
                    );
                  })}
                </View>
              ) : (
                <Text style={{ color: c.inkMuted }}>{t('trending.empty')}</Text>
              )}
            </View>

            {communities.length ? (
              <View style={{ gap: space[2] }}>
                <SectionHeader title={t('m.wander.communitiesToJoin')} action={{ label: t('m.wander.seeAll'), onPress: () => router.push('/communities') }} />
                {communities.map((x) => (
                  <Row
                    key={x.id}
                    title={x.name}
                    subtitle={tp('m.community.members', x.memberCount)}
                    start={<Avatar name={x.name} size={36} />}
                    onPress={() => router.push(`/c/${x.slug}`)}
                  />
                ))}
              </View>
            ) : null}

            {events.length ? (
              <View style={{ gap: space[2] }}>
                <SectionHeader title={t('m.wander.comingUp')} action={{ label: t('m.wander.seeAll'), onPress: () => router.push('/events') }} />
                {events.map((e) => (
                  <Row
                    key={e.id}
                    title={e.title}
                    subtitle={[dateTime(e.startsAt), e.online ? t('m.event.online') : (e.place?.name ?? e.locationText)].filter(Boolean).join(' · ')}
                    start={<Icon name="calendar-outline" size={22} color={c.yapi} />}
                    onPress={() => router.push(`/event/${e.id}`)}
                  />
                ))}
              </View>
            ) : null}
          </>
        ) : nothing ? (
          <EmptyState title={t('m.wander.noResults', { query: term })} body={t('m.wander.noResultsBody')} />
        ) : found ? (
          <>
            {showing ? (
              <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>
                {showing}
              </Text>
            ) : null}
            {show('people') && found.people.length ? (
              <View style={{ gap: space[2] }}>
                <SectionHeader title={t('discover.people')} action={seeAll('people', found.people.length)} />
                {cut(found.people).map((u) => (
                  <Row
                    key={u.id}
                    title={u.displayName}
                    subtitle={`@${u.username}`}
                    start={<Avatar name={u.displayName} url={u.avatarUrl} size={40} />}
                    onPress={() => open(`/u/${encodeURIComponent(u.username)}`)}
                  />
                ))}
              </View>
            ) : null}

            {show('topics') && found.topics.length ? (
              <View style={{ gap: space[2] }}>
                <SectionHeader title={t('m.wander.tags')} />
                <ChipRow>
                  {found.topics.map((x) => (
                    <Chip
                      key={x.slug}
                      label={`#${x.slug}`}
                      meta={x.posts ? number(x.posts, { notation: 'compact' }) : undefined}
                      a11yLabel={x.posts ? `#${x.slug}. ${tp('trending.posts', x.posts, { number: number(x.posts) })}` : `#${x.slug}`}
                      onPress={() => open(`/t/${encodeURIComponent(x.slug)}`)}
                    />
                  ))}
                </ChipRow>
              </View>
            ) : null}

            {show('communities') && found.communities.length ? (
              <View style={{ gap: space[2] }}>
                <SectionHeader title={t('discover.communities')} action={seeAll('communities', found.communities.length)} />
                {cut(found.communities).map((x) => (
                  <Row
                    key={x.id}
                    title={x.name}
                    subtitle={tp('m.community.members', x.memberCount)}
                    start={<Avatar name={x.name} size={36} />}
                    onPress={() => open(`/c/${x.slug}`)}
                  />
                ))}
              </View>
            ) : null}

            {show('events') && found.events.length ? (
              <View style={{ gap: space[2] }}>
                <SectionHeader title={t('discover.events')} action={seeAll('events', found.events.length)} />
                {cut(found.events).map((e) => (
                  <Row
                    key={e.id}
                    title={e.title}
                    subtitle={[dateTime(e.startsAt), e.online ? t('m.event.online') : (e.place?.name ?? e.locationText)].filter(Boolean).join(' · ')}
                    start={<Icon name="calendar-outline" size={22} color={c.yapi} />}
                    onPress={() => open(`/event/${e.id}`)}
                  />
                ))}
              </View>
            ) : null}

            {show('places') && found.places.length ? (
              <View style={{ gap: space[2] }}>
                <SectionHeader title={t('discover.places')} action={seeAll('places', found.places.length)} />
                {cut(found.places).map((p) => (
                  <Row
                    key={p.id}
                    title={p.name}
                    subtitle={[p.category, p.city].filter(Boolean).join(' · ')}
                    start={<Icon name="location-outline" size={22} color={c.yapi} />}
                    onPress={() => open(`/place/${p.id}`)}
                  />
                ))}
              </View>
            ) : null}

            {tab === 'all' && found.products.length ? (
              <View style={{ gap: space[2] }}>
                <SectionHeader title={t('discover.products')} />
                {found.products.map((p) => (
                  <Row
                    key={p.id}
                    title={p.title}
                    subtitle={formatMoney(p.priceCents, p.currency, locale)}
                    start={<Icon name="bag-outline" size={22} color={c.yapi} />}
                    onPress={() => open(`/product?username=${encodeURIComponent(p.sellerUsername!)}&id=${p.id}`)}
                  />
                ))}
              </View>
            ) : null}

            {show('posts') && found.posts.length ? (
              <View style={{ gap: space[3] }}>
                <SectionHeader title={t('discover.posts')} action={seeAll('posts', found.posts.length)} />
                {cut(found.posts).map((p) => (
                  <PostCard key={p.id} post={p} />
                ))}
              </View>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
