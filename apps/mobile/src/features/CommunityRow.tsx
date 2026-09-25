import React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { Community } from '@yapilapi/api-client';
import { useTheme } from '../theme';
import { useT } from '../i18n';
import { AppText, Avatar } from '../ui';

export function CommunityRow({ community }: { community: Community }) {
  const th = useTheme();
  const t = useT();
  const router = useRouter();
  const st = community.viewer?.status;
  const status =
    st === 'active'
      ? t('communities.member')
      : st === 'pending'
        ? t('communities.requested')
        : st === 'invited'
          ? t('communities.invited')
          : community.joinPolicy === 'invite'
            ? t('communities.inviteOnly')
            : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${community.name}. ${t('common.members', { count: community.memberCount })}${status ? `. ${status}` : ''}. ${t(`communities.visibility.${community.visibility}`)}`}
      onPress={() => router.push({ pathname: '/community/[id]', params: { id: community.id } })}
      style={{
        flexDirection: 'row',
        gap: th.space[3],
        padding: th.space[4],
        backgroundColor: th.colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: th.colors.border,
        minHeight: 72,
      }}
    >
      <Avatar name={community.name} size={48} />
      <View style={{ flex: 1 }}>
        <AppText variant="bodyStrong" numberOfLines={1}>
          {community.name}
        </AppText>
        {community.description ? (
          <AppText variant="caption" tone="muted" numberOfLines={2}>
            {community.description}
          </AppText>
        ) : null}
        <AppText
          variant="caption"
          tone="subtle"
        >{`${t('common.members', { count: community.memberCount })} · ${t(`communities.visibility.${community.visibility}`)}${status ? ` · ${status}` : ''}`}</AppText>
      </View>
    </Pressable>
  );
}
