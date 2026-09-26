import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { TrendingTag } from '../../../packages/api-client/src/index';
import type { Post } from '../../../packages/shared/src/types';
import { client, mediaUrl } from './api';
import { useT } from './i18n';
import { useSession } from './session';
import { radius, space } from './theme';
import { Button, Icon, useColors, userText } from './ui';

/** Home shows the starter row while someone follows fewer than this many people. */
const STARTER_BELOW = 3;

/**
 * For people who follow fewer than three accounts: reels to start with (from the reels feed,
 * which follows their interests) and trending tags, so Home is never empty.
 */
export function StarterRow() {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const [reels, setReels] = useState<Post[]>([]);
  const [tags, setTags] = useState<TrendingTag[]>([]);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!me) return;
    let live = true;
    void (async () => {
      const api = await client();
      const profile = await api.users.get(me.username).catch(() => null);
      if (!live || !profile || profile.profile.counts.following >= STARTER_BELOW) return;
      setShow(true);
      const [r, tr] = await Promise.all([api.reels().catch(() => null), api.trending(8).catch(() => null)]);
      if (!live) return;
      setReels((r?.items ?? []).filter((p) => p.author.id !== me.id).slice(0, 10));
      setTags(tr?.items ?? []);
    })();
    return () => {
      live = false;
    };
  }, [me]);

  if (!show || (!reels.length && !tags.length)) return null;
  return (
    <View style={{ gap: space[2] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[2] }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800', flexShrink: 1 }}>
          {t('starter.reels')}
        </Text>
        <Button size="sm" variant="ghost" label={t('friends.title')} onPress={() => router.push('/find-friends')} />
      </View>
      <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>{t('starter.body')}</Text>
      {reels.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[2] }}>
          {reels.map((p) => {
            const media = p.media.find((m) => m.kind === 'video') ?? p.media[0];
            return (
              <Pressable
                key={p.id}
                accessibilityRole="button"
                accessibilityLabel={t('m.reels.by', { name: p.author.displayName })}
                onPress={() => router.push({ pathname: '/reels', params: { start: p.id } })}
                style={[s.reel, { backgroundColor: c.surfaceSunken }]}
              >
                {media?.posterUrl ? (
                  <Image source={{ uri: mediaUrl(media.posterUrl) }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                ) : (
                  <Icon name="play" size={28} color={c.inkMuted} />
                )}
                <View style={s.by}>
                  <Text style={[s.byText, userText]} numberOfLines={1}>
                    {p.author.displayName}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      {tags.length ? (
        <>
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 15, fontWeight: '700' }}>
            {t('starter.tags')}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            {tags.map((tg) => (
              <Pressable
                key={tg.tag}
                accessibilityRole="link"
                onPress={() => router.push(`/t/${encodeURIComponent(tg.tag)}`)}
                style={[s.tag, { borderColor: c.lineStrong, backgroundColor: c.surface }]}
              >
                <Text style={[{ color: c.ink, fontWeight: '600' }, userText]}>#{tg.tag}</Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  reel: { width: 108, aspectRatio: 9 / 16, borderRadius: radius.md, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  by: { position: 'absolute', start: 0, end: 0, bottom: 0, padding: space[2], backgroundColor: 'rgba(0,0,0,0.45)' },
  byText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  tag: { height: 34, paddingHorizontal: space[3], borderRadius: radius.full, borderWidth: 1, justifyContent: 'center' },
});
