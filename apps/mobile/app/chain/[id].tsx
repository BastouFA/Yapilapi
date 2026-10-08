import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Image, Pressable, Text, View } from 'react-native';
import type { ChainJoin } from '../../../../packages/shared/src/constants';
import type { Chain } from '../../../../packages/shared/src/pass-the-mic';
import type { Post } from '../../../../packages/shared/src/types';
import { client, errorMessage, isGone, mediaUrl } from '../../lib/api';
import { JoinChoice, PassMicSheet, takeTheMic, useChainCounts } from '../../lib/chains';
import { useT } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import { Avatar, Button, EmptyState, ErrorState, Loading, Notice, ScreenError, useColors, useRefresh, userText } from '../../lib/ui';

/**
 * A Pass the Mic chain: its prompt, who started it, how many reels and people are in it, "Take the
 * mic" when you may, and its reels in order (each opens in Reels). The starter closes or reopens
 * it and chooses who can take the mic here.
 */
export default function ChainScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, tp, number } = useT();
  const { me } = useSession();
  const countsText = useChainCounts();
  const [chain, setChain] = useState<Chain | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [items, setItems] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [passing, setPassing] = useState(false);

  const loadChain = useCallback(async () => {
    try {
      setChain((await (await client()).chains.get(id)).chain);
      setLoadError(null);
    } catch (e) {
      if (isGone(e)) setChain(null);
      else setLoadError(errorMessage(e));
    }
  }, [id]);
  const load = useCallback(
    async (next?: string) => {
      setError(null);
      try {
        const page = await (await client()).chains.links(id, next);
        setItems((cur) => (next ? [...(cur ?? []), ...page.items.filter((x) => !cur?.some((y) => y.id === x.id))] : page.items));
        setCursor(page.nextCursor);
      } catch (e) {
        setItems((cur) => cur ?? []);
        setError(errorMessage(e));
      }
    },
    [id],
  );
  useEffect(() => {
    void loadChain();
    void load();
  }, [loadChain, load]);
  const refresh = useRefresh(() => Promise.all([loadChain(), load()]));
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), 3500);
    return () => clearTimeout(timer);
  }, [status]);

  if (chain === undefined) return loadError ? <ScreenError message={loadError} onRetry={loadChain} /> : <Loading />;
  if (chain === null)
    return (
      <EmptyState
        title={t('mic.title')}
        body={t('mic.unavailable')}
        icon="mic-outline"
        action={{ label: t('m.common.retry'), icon: 'refresh', onPress: () => void loadChain() }}
      />
    );

  async function setWho(whoCanJoin: ChainJoin) {
    if (!chain || whoCanJoin === chain.whoCanJoin) return;
    setError(null);
    try {
      const r = await (await client()).chains.edit(chain.id, { whoCanJoin });
      setChain(r.chain);
      setStatus(t('mic.saved'));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const header = (
    <View style={{ gap: space[3], marginBottom: space[3] }}>
      <Text style={{ color: c.inkMuted, fontWeight: '700', fontSize: 13 }}>{t('mic.title')}</Text>
      <Text accessibilityRole="header" style={[{ color: c.ink, fontSize: 22, fontWeight: '800', lineHeight: 28 }, userText]}>
        {chain.prompt}
      </Text>
      <Pressable
        accessibilityRole="link"
        onPress={() => router.push(`/u/${chain.starter.username}`)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 44, alignSelf: 'flex-start' }}
      >
        <Avatar name={chain.starter.displayName} url={chain.starter.avatarUrl} size={28} />
        <Text style={[{ color: c.ink, fontWeight: '600' }, userText]}>{t('mic.startedBy', { name: chain.starter.displayName })}</Text>
      </Pressable>
      <Text style={{ color: c.inkMuted, fontSize: 14 }}>{countsText(chain.counts)}</Text>
      {chain.viewer.canJoin ? (
        <Button label={t('mic.take')} icon="mic-outline" onPress={() => takeTheMic(chain.id)} />
      ) : chain.closed || chain.viewer.why === 'closed' ? (
        <Notice>{t('mic.closed')}</Notice>
      ) : null}
      {chain.firstPostId ? (
        <Button
          label={t('mic.playFromStart')}
          icon="play-outline"
          variant="secondary"
          onPress={() => router.push({ pathname: '/reels', params: { start: chain.firstPostId! } })}
        />
      ) : null}
      {me && !chain.closed ? <Button label={t('mic.pass')} icon="paper-plane-outline" variant="secondary" onPress={() => setPassing(true)} /> : null}
      {chain.viewer.isStarter ? (
        <View style={{ gap: space[2] }}>
          <Button
            label={chain.closed ? t('mic.reopen') : t('mic.close')}
            icon={chain.closed ? 'lock-open-outline' : 'lock-closed-outline'}
            variant="secondary"
            size="sm"
            style={{ alignSelf: 'flex-start' }}
            onPress={() => setWho(chain.closed ? 'everyone' : 'nobody')}
          />
          <JoinChoice value={chain.whoCanJoin} onChange={(v) => v && void setWho(v)} withNobody />
        </View>
      ) : null}
      {status ? (
        <View accessibilityLiveRegion="polite">
          <Notice>{status}</Notice>
        </View>
      ) : null}
      {error ? <ErrorState message={error} onRetry={() => load()} /> : null}
    </View>
  );

  return (
    <>
      <FlatList
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4] }}
        columnWrapperStyle={{ gap: 4 }}
        data={items ?? []}
        numColumns={3}
        keyExtractor={(p) => p.id}
        refreshControl={refresh}
        ListHeaderComponent={header}
        ItemSeparatorComponent={() => <View style={{ height: 4 }} />}
        renderItem={({ item }) => {
          const m = item.media.find((x) => x.kind === 'video') ?? item.media[0];
          const poster = m ? (m.variants?.thumb ?? m.posterUrl) : null;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                item.chain
                  ? `${t('m.reels.by', { name: item.author.displayName })}. ${t('mic.bar', { position: item.chain.position, total: item.chain.total })}`
                  : t('m.reels.by', { name: item.author.displayName })
              }
              onPress={() => router.push({ pathname: '/reels', params: { start: item.id } })}
              style={{ flex: 1 / 3, aspectRatio: 9 / 16, borderRadius: radius.md, overflow: 'hidden', backgroundColor: '#05060B' }}
            >
              {poster ? <Image source={{ uri: mediaUrl(poster) }} style={{ width: '100%', height: '100%' }} resizeMode="cover" /> : null}
              <View style={{ position: 'absolute', bottom: 6, start: 6, end: 6 }}>
                <Text
                  style={[{ color: '#FFFFFF', fontSize: 12, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.7)', textShadowRadius: 3 }, userText]}
                  numberOfLines={1}
                >
                  @{item.author.username}
                </Text>
              </View>
            </Pressable>
          );
        }}
        onEndReached={() => cursor && void load(cursor)}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={items === null ? <Loading /> : error ? null : <EmptyState title={t('mic.empty')} />}
      />
      <PassMicSheet
        chainId={passing ? chain.id : null}
        onClose={() => setPassing(false)}
        onPassed={(n) => setStatus(tp('mic.pass.sent', n, { count: number(n) }))}
      />
    </>
  );
}
