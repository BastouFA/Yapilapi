import React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../theme';
import { useI18n } from '../../i18n';
import type { AppNotification } from '../../api';
import {
  useMarkNotificationRead,
  useNotifications,
  useReadAllNotifications,
} from '../../data/notifications';
import { relativeTime } from '../../lib/format';
import { notificationText } from '../../features/notificationText';
import { routeForNotification } from '../../push/routing';
import { AppText, Avatar, Button, EmptyView, PagedList } from '../../ui';

function Row({ n }: { n: AppNotification }) {
  const th = useTheme();
  const { t, locale } = useI18n();
  const router = useRouter();
  const read = useMarkNotificationRead();
  const text = notificationText(n, t);
  const open = () => {
    if (!n.read) read.mutate(n.id);
    const to = routeForNotification({
      kind: n.kind,
      targetType: n.targetType,
      targetId: n.targetId,
      data: n.data,
      actorUsername: n.actor?.username,
    });
    if (to) router.push(to as never);
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${text}. ${relativeTime(n.createdAt, locale)}${n.read ? '' : `. ${t('notifications.unread')}`}`}
      accessibilityHint={t('notifications.open')}
      onPress={open}
      style={{
        flexDirection: 'row',
        gap: th.space[3],
        padding: th.space[4],
        minHeight: 64,
        alignItems: 'center',
        backgroundColor: n.read ? th.colors.surface : th.colors.primarySoft,
        borderBottomWidth: 1,
        borderBottomColor: th.colors.border,
      }}
    >
      <Avatar
        name={n.actor?.displayName ?? t('notifications.someone')}
        uri={n.actor?.avatarUrl}
        size={40}
      />
      <View style={{ flex: 1 }}>
        <AppText variant={n.read ? 'body' : 'bodyStrong'}>{text}</AppText>
        <AppText variant="caption" tone="subtle">
          {relativeTime(n.createdAt, locale)}
        </AppText>
      </View>
    </Pressable>
  );
}

export default function Notifications() {
  const th = useTheme();
  const t = useI18n().t;
  const list = useNotifications();
  const readAll = useReadAllNotifications();
  return (
    <View style={{ flex: 1, backgroundColor: th.colors.bg }}>
      {list.items.some((n) => !n.read) ? (
        <View
          style={{
            alignItems: 'flex-end',
            padding: th.space[2],
            backgroundColor: th.colors.surface,
          }}
        >
          <Button
            label={t('notifications.markAll')}
            variant="ghost"
            compact
            loading={readAll.isPending}
            onPress={() => readAll.mutate()}
          />
        </View>
      ) : null}
      <PagedList
        query={list}
        renderItem={({ item }) => <Row n={item} />}
        empty={<EmptyView message={t('notifications.empty')} />}
      />
    </View>
  );
}
