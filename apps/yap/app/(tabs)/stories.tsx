import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import type { StoryGroup } from '../../../../packages/api-client/src/index';
import { client, errorMessage } from '../../../mobile/lib/api';
import { onBackOnline } from '../../../mobile/lib/network';
import { useT } from '../../../mobile/lib/i18n';
import { useSession } from '../../../mobile/lib/session';
import { StoryViewer } from '../../../mobile/lib/stories';
import { radius, space } from '../../../mobile/lib/theme';
import { Avatar, EmptyState, ErrorState, SkeletonList, useColors } from '../../../mobile/lib/ui';
import { openInYapilapi } from '../../lib/elsewhere';
import { ListRow, RoundButton, RowIcon, RowLine } from '../../lib/rows';

type Item = { kind: 'heading'; text: string } | { kind: 'mine' } | { kind: 'group'; index: number };

/** Stories are made in YAPILAPI, with its camera and editor. */
const addStory = () => void openInYapilapi('/camera?mode=story');

/** An avatar inside a ring: brand colour for stories you haven't seen, grey once seen. */
function Ring({ name, url, seen }: { name: string; url: string | null | undefined; seen: boolean }) {
  const c = useColors();
  return (
    <View style={{ width: 50, height: 50, borderRadius: radius.full, borderWidth: 2, borderColor: seen ? c.lineStrong : c.yapi, padding: 2 }}>
      <Avatar name={name} url={url} size={42} />
    </View>
  );
}

/**
 * Stories: yours first (or Add to your story, which opens YAPILAPI), then the people you follow,
 * new ones before the ones you've seen. Tapping one plays it in the phone app's story viewer, where
 * you can like it and reply (the reply arrives in your chat with them).
 */
export default function Stories() {
  const c = useColors();
  const { t, timeAgo } = useT();
  const { me } = useSession();
  const [groups, setGroups] = useState<StoryGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchStories = useCallback(async () => {
    try {
      const items = (await (await client()).moments.list()).items;
      // Yours, then new, then seen: the viewer moves through them in this order too.
      setGroups([...items.filter((g) => g.mine), ...items.filter((g) => !g.mine && !g.allSeen), ...items.filter((g) => !g.mine && g.allSeen)]);
      setError(null);
    } catch (e) {
      setGroups((cur) => cur ?? []);
      setError(errorMessage(e));
    }
  }, []);
  // Not while a story is open: the viewer keeps its own place.
  useFocusEffect(
    useCallback(() => {
      if (viewing === null) void fetchStories();
    }, [fetchStories, viewing]),
  );
  useEffect(() => onBackOnline(() => void fetchStories()), [fetchStories]);

  const items = useMemo<Item[]>(() => {
    if (!groups) return [];
    const out: Item[] = [{ kind: 'mine' }];
    const fresh = groups.map((g, index) => ({ g, index })).filter(({ g }) => !g.mine && !g.allSeen);
    const seen = groups.map((g, index) => ({ g, index })).filter(({ g }) => !g.mine && g.allSeen);
    if (fresh.length) out.push({ kind: 'heading', text: t('yapApp.stories.new') }, ...fresh.map(({ index }) => ({ kind: 'group' as const, index })));
    if (seen.length) out.push({ kind: 'heading', text: t('yapApp.stories.seen') }, ...seen.map(({ index }) => ({ kind: 'group' as const, index })));
    return out;
  }, [groups, t]);

  if (!groups) return <SkeletonList />;
  const mineIndex = groups.findIndex((g) => g.mine);
  const latest = (g: StoryGroup) => g.moments[g.moments.length - 1]?.createdAt;
  const others = groups.length - (mineIndex >= 0 ? 1 : 0);

  return (
    <>
      <FlatList
        style={{ flex: 1, backgroundColor: c.ground }}
        data={items}
        keyExtractor={(x, i) => (x.kind === 'group' ? groups[x.index]!.author.id : `${x.kind}-${i}`)}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={c.yapi}
            colors={[c.yapi]}
            onRefresh={async () => {
              setRefreshing(true);
              await fetchStories();
              setRefreshing(false);
            }}
          />
        }
        ListHeaderComponent={error ? <ErrorState message={error} onRetry={fetchStories} style={{ margin: space[4] }} /> : null}
        ListFooterComponent={
          others || error ? null : <EmptyState icon="aperture-outline" title={t('yapApp.stories.empty')} body={t('yapApp.stories.emptyBody')} />
        }
        renderItem={({ item, index }) => {
          if (item.kind === 'heading')
            return (
              <Text
                accessibilityRole="header"
                style={{
                  color: c.inkMuted,
                  fontSize: 13,
                  fontWeight: '800',
                  letterSpacing: 0.6,
                  textTransform: 'uppercase',
                  paddingHorizontal: space[4],
                  paddingTop: space[4],
                  paddingBottom: space[1],
                }}
              >
                {item.text}
              </Text>
            );
          if (item.kind === 'mine') {
            const mine = mineIndex >= 0 ? groups[mineIndex]! : null;
            const when = mine ? latest(mine) : undefined;
            return mine && me ? (
              <ListRow
                name={me.displayName}
                start={<Ring name={me.displayName} url={me.avatarUrl} seen={false} />}
                title={t('m.stories.yours')}
                subtitle={when ? timeAgo(when) : undefined}
                onPress={() => setViewing(mineIndex)}
                end={<RoundButton icon="add-circle-outline" label={t('m.stories.add')} onPress={addStory} />}
              />
            ) : (
              <ListRow
                name={t('m.stories.add')}
                start={<RowIcon icon="add" />}
                title={t('m.stories.add')}
                subtitle={t('yapApp.stories.addHint')}
                onPress={addStory}
              />
            );
          }
          const g = groups[item.index]!;
          const when = latest(g);
          const next = items[index + 1];
          return (
            <>
              <ListRow
                name={g.author.displayName}
                start={<Ring name={g.author.displayName} url={g.author.avatarUrl} seen={g.allSeen} />}
                title={g.author.displayName}
                subtitle={when ? timeAgo(when) : undefined}
                label={`${g.allSeen ? t('m.stories.a11y.seen', { name: g.author.displayName }) : t('m.stories.a11y.new', { name: g.author.displayName })}${when ? `, ${timeAgo(when)}` : ''}`}
                onPress={() => setViewing(item.index)}
              />
              {next?.kind === 'group' ? <RowLine /> : null}
            </>
          );
        }}
      />
      <StoryViewer groups={groups} start={viewing} onClose={() => setViewing(null)} onChange={setGroups} />
    </>
  );
}
