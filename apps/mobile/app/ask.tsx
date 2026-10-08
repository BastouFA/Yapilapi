import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, FlatList, Keyboard, Pressable, Text, TextInput, View } from 'react-native';
import { ApiError } from '../../../packages/api-client/src/index';
import type { AskTopic } from '../../../packages/shared/src/ask-city';
import type { MapBox } from '../../../packages/shared/src/city-map';
import type { Post } from '../../../packages/shared/src/types';
import { client, errorMessage } from '../lib/api';
import { AskForm, HelperCard, TopicChips } from '../lib/ask-city';
import { useFlag } from '../lib/flags';
import { useT } from '../lib/i18n';
import { PostCard } from '../lib/post';
import { useSession } from '../lib/session';
import { radius, space } from '../lib/theme';
import { Button, EmptyState, ErrorState, feedListProps, Icon, KeyboardAvoid, Loading, Notice, Segmented, useColors, useRefresh, userText } from '../lib/ui';

/** ?south&west&north&east from Near you: the part of the map a question can be about. */
function boxFrom(p: Record<string, string | undefined>): MapBox | null {
  const n = (k: string) => (p[k] !== undefined && p[k] !== '' ? Number(p[k]) : NaN);
  const b = { south: n('south'), west: n('west'), north: n('north'), east: n('east') };
  return Object.values(b).every(Number.isFinite) && b.north > b.south && b.east > b.west ? b : null;
}

const isOff = (e: unknown) => e instanceof ApiError && e.code === 'feature_disabled';

/** Outside the component, so it's the same function on every render and the list leaves its rows alone. */
const renderPost = ({ item }: { item: Post }) => <PostCard post={item} />;

/**
 * Ask the city (docs/product/ask-the-city.md): open questions near you (your city, one you search
 * for, or the part of the map you came from), those waiting for an answer first, by topic; your own
 * questions; asking one (by voice or in writing); and "Help answer questions near me". Answers are
 * the comments under each question, by voice or text; the asker marks the helpful ones. Opened
 * from the map with ?ask=1 and its box, the form is open and can ask about that part of the map.
 */
export default function AskCityScreen() {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const on = useFlag('ASK_CITY');
  const mapOn = useFlag('CITY_MAP') !== false;
  const params = useLocalSearchParams<{ ask?: string; city?: string; south?: string; west?: string; north?: string; east?: string }>();
  const fromMap = useMemo(() => boxFrom(params), [params.south, params.west, params.north, params.east]); // eslint-disable-line react-hooks/exhaustive-deps

  const [tab, setTab] = useState<'near' | 'mine'>('near');
  const [asking, setAsking] = useState(params.ask === '1');
  const [box, setBox] = useState<MapBox | null>(fromMap);
  const [city, setCity] = useState<string | null>(params.city || null);
  const [listed, setListed] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [topic, setTopic] = useState<AskTopic | null>(null);
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [off, setOff] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Answers for a list you've already left (another city, topic or tab) are dropped.
  const seq = useRef(0);
  const load = useCallback(
    async (next?: string) => {
      const run = next ? seq.current : ++seq.current;
      const api = await client();
      // Near you also says which city it listed (yours, when none was searched for).
      const near = tab === 'near' ? await api.askCity.list({ ...(box ? { box } : city ? { city } : {}), ...(topic ? { topic } : {}), cursor: next }) : null;
      const page = near ?? (await api.askCity.mine(next));
      if (run !== seq.current) return;
      if (near) setListed(near.city);
      setPosts((cur) => (next && cur ? [...cur, ...page.items.filter((x) => !cur.some((y) => y.id === x.id))] : page.items));
      setCursor(page.nextCursor);
    },
    [tab, box, city, topic],
  );
  const loadFirst = useCallback(async () => {
    setError(null);
    try {
      await load();
    } catch (e) {
      if (isOff(e)) setOff(true);
      setPosts((cur) => cur ?? []);
      setError(errorMessage(e));
    }
  }, [load]);
  useEffect(() => {
    if (!me || on === false) return;
    setPosts(null);
    setCursor(null);
    void loadFirst();
  }, [loadFirst, me?.id, on]); // eslint-disable-line react-hooks/exhaustive-deps
  // The end of the list can be reached more than once before the next page arrives: ask once.
  const fetching = useRef<string | null>(null);
  const loadMore = () => {
    if (!cursor || fetching.current === cursor) return;
    fetching.current = cursor;
    void load(cursor)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => {
        fetching.current = null;
      });
  };
  const refresh = useRefresh(loadFirst);

  if (me === undefined) return <Loading />;
  if (!me)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice>{t('m.common.signedOut')}</Notice>
      </View>
    );
  if (off || on === false)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('featureOff.title', { name: t('askCity.title') })} body={t('featureOff.body')} icon="help-circle-outline" />
      </View>
    );

  function findCity() {
    const q = search.trim();
    if (!q) return;
    Keyboard.dismiss();
    setBox(null);
    setCity(q);
  }

  const near = tab === 'near';
  const header = (
    <View style={{ gap: space[3], marginBottom: space[1] }}>
      <Text style={{ color: c.inkMuted, fontSize: 15, lineHeight: 22 }}>{t('askCity.hint')}</Text>
      {note ? (
        <View accessibilityLiveRegion="polite">
          <Notice>{note}</Notice>
        </View>
      ) : null}
      {asking ? (
        <AskForm
          city={listed ?? city}
          box={box}
          onCancel={() => setAsking(false)}
          onAsked={(said) => {
            setAsking(false);
            setNote(said);
            AccessibilityInfo.announceForAccessibility(said);
            void loadFirst();
          }}
        />
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          <Button
            label={t('askCity.ask')}
            icon="help-circle-outline"
            onPress={() => {
              setNote(null);
              setAsking(true);
            }}
          />
          {mapOn ? <Button label={t('map.title')} icon="map-outline" variant="secondary" onPress={() => router.push('/map')} /> : null}
        </View>
      )}

      <Segmented
        label={t('askCity.title')}
        value={tab}
        onChange={setTab}
        options={[
          { id: 'near', label: t('map.title') },
          { id: 'mine', label: t('askCity.mine') },
        ]}
      />

      {near ? (
        <>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: space[2],
              minHeight: 44,
              borderRadius: radius.full,
              borderWidth: 1,
              borderColor: c.line,
              backgroundColor: c.surface,
              paddingStart: space[4],
            }}
          >
            <Icon name="search" size={18} color={c.inkMuted} />
            <TextInput
              accessibilityLabel={t('map.searchCity')}
              placeholder={t('map.searchCity')}
              placeholderTextColor={c.inkMuted}
              value={search}
              onChangeText={setSearch}
              onSubmitEditing={findCity}
              returnKeyType="search"
              autoCorrect={false}
              maxLength={60}
              style={[{ flex: 1, color: c.ink, fontSize: 16, paddingVertical: space[2] }, userText]}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('map.searchCity')}
              accessibilityState={{ disabled: !search.trim() }}
              disabled={!search.trim()}
              onPress={findCity}
              style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', opacity: search.trim() ? 1 : 0.45 }}
            >
              <Icon name="arrow-forward" size={20} color={c.yapi} directional />
            </Pressable>
          </View>
          {box ? (
            <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
              {t('askCity.mapArea')}
            </Text>
          ) : listed ? (
            <Text accessibilityRole="header" style={[{ color: c.ink, fontSize: 17, fontWeight: '800' }, userText]}>
              {t('askCity.in', { city: listed })}
            </Text>
          ) : null}
          <TopicChips value={topic} onChange={setTopic} all />
        </>
      ) : null}
      {error && posts?.length ? <ErrorState message={error} onRetry={loadFirst} /> : null}
    </View>
  );

  return (
    <KeyboardAvoid style={{ backgroundColor: c.ground }}>
      <FlatList
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        {...feedListProps}
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: space[8] }}
        data={posts ?? []}
        keyExtractor={(p) => p.id}
        refreshControl={refresh}
        ListHeaderComponent={header}
        renderItem={renderPost}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          posts === null ? (
            <Loading />
          ) : error ? (
            <ErrorState message={error} onRetry={loadFirst} />
          ) : (
            <EmptyState
              title={near ? t('askCity.title') : t('askCity.mine')}
              body={!near || listed || box ? t('askCity.empty') : t('askCity.noCity')}
              icon="help-circle-outline"
            />
          )
        }
        ListFooterComponent={near ? <HelperCard /> : null}
      />
    </KeyboardAvoid>
  );
}
