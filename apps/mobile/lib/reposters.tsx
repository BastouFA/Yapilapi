import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import type { PublicUser } from '../../../packages/shared/src/types';
import { client, errorMessage } from './api';
import { useT } from './i18n';
import { Sheet } from './post-edit';
import { radius, space } from './theme';
import { Avatar, Button, useColors, userText } from './ui';

/**
 * "Reposted by": who reposted your post, newest first. People with private accounts show only
 * to their followers. Tapping someone opens their profile.
 */
export function RepostersSheet({ postId, onClose }: { postId: string | null; onClose: () => void }) {
  const c = useColors();
  const { t } = useT();
  const [items, setItems] = useState<PublicUser[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!postId) return;
    let current = true;
    setItems(null);
    setCursor(null);
    setError(null);
    void client()
      .then((api) => api.posts.reposters(postId))
      .then(
        (r) => {
          if (!current) return;
          setItems(r.items);
          setCursor(r.nextCursor);
        },
        (e) => {
          if (!current) return;
          setItems([]);
          setError(errorMessage(e));
        },
      );
    return () => {
      current = false;
    };
  }, [postId]);

  async function more() {
    if (!postId || !cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await (await client()).posts.reposters(postId, cursor);
      setItems((cur) => [...(cur ?? []), ...r.items.filter((u) => !cur?.some((x) => x.id === u.id))]);
      setCursor(r.nextCursor);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Sheet visible={!!postId} title={t('reposters.title')} onClose={onClose}>
      {error ? <Text style={{ color: c.danger, lineHeight: 20 }}>{error}</Text> : null}
      {items === null ? (
        <ActivityIndicator color={c.yapi} style={{ paddingVertical: space[4] }} accessibilityLabel={t('common.loading')} />
      ) : items.length ? (
        <View style={{ gap: space[1] }}>
          {items.map((u) => (
            <Pressable
              key={u.id}
              accessibilityRole="link"
              accessibilityLabel={`${u.displayName}, @${u.username}`}
              onPress={() => {
                onClose();
                router.push(`/u/${u.username}`);
              }}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: space[3],
                minHeight: 56,
                paddingHorizontal: space[2],
                borderRadius: radius.md,
                backgroundColor: pressed ? c.surfaceSunken : 'transparent',
              })}
            >
              <Avatar name={u.displayName} url={u.avatarUrl} size={40} />
              <View style={{ flex: 1 }}>
                <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 15 }, userText]} numberOfLines={1}>
                  {u.displayName}
                </Text>
                <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
                  @{u.username}
                </Text>
              </View>
            </Pressable>
          ))}
          {cursor ? (
            <Button
              label={t('follow.showMore')}
              variant="secondary"
              size="sm"
              disabled={loadingMore}
              onPress={() => void more()}
              style={{ alignSelf: 'center' }}
            />
          ) : null}
        </View>
      ) : error ? null : (
        <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('reposters.empty')}</Text>
      )}
    </Sheet>
  );
}
