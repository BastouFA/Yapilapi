import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import type { PublicUser } from '../../../packages/shared/src/types';
import { client } from './api';
import { useT } from './i18n';
import { useSession } from './session';
import { radius, space } from './theme';
import { Avatar, Icon, useColors, userText } from './ui';

/** Your friends (up to 100), for sharing a memory or inviting people to a Together. null while loading. */
export function useFriends(): PublicUser[] | null {
  const { me } = useSession();
  const [friends, setFriends] = useState<PublicUser[] | null>(null);
  useEffect(() => {
    if (!me) return;
    let live = true;
    client()
      .then((api) => api.raw.get<{ items: PublicUser[] }>(`/v1/users/${me.id}/friends?limit=100`))
      .then(
        (r) => live && setFriends(r.items),
        () => live && setFriends([]),
      );
    return () => {
      live = false;
    };
  }, [me]);
  return friends;
}

/** A list of friends to tick. Each row is a checkbox for screen readers, at least 52pt tall. */
export function FriendPicker({
  friends,
  picked,
  onChange,
  empty,
}: {
  friends: PublicUser[] | null;
  picked: Set<string>;
  onChange: (next: Set<string>) => void;
  empty: string;
}) {
  const c = useColors();
  const { t } = useT();
  if (friends === null) return <ActivityIndicator color={c.yapi} accessibilityLabel={t('common.loading')} style={{ paddingVertical: space[3] }} />;
  if (!friends.length) return <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{empty}</Text>;
  return (
    <View style={{ gap: space[1] }}>
      {friends.map((f) => {
        const on = picked.has(f.id);
        return (
          <Pressable
            key={f.id}
            accessibilityRole="checkbox"
            accessibilityLabel={f.displayName}
            accessibilityState={{ checked: on }}
            onPress={() => {
              const next = new Set(picked);
              if (on) next.delete(f.id);
              else next.add(f.id);
              onChange(next);
            }}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: space[3],
              minHeight: 52,
              paddingHorizontal: space[2],
              borderRadius: radius.md,
              backgroundColor: pressed ? c.surfaceSunken : 'transparent',
            })}
          >
            <Avatar name={f.displayName} url={f.avatarUrl} size={36} />
            <Text style={[{ flex: 1, color: c.ink, fontWeight: '600', fontSize: 15 }, userText]} numberOfLines={1}>
              {f.displayName}
            </Text>
            <Icon name={on ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={on ? c.yapi : c.inkMuted} />
          </Pressable>
        );
      })}
    </View>
  );
}
