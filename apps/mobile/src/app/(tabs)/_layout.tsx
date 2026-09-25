import React from 'react';
import { Pressable, View, type ColorValue } from 'react-native';
import { Tabs, useRouter } from 'expo-router';
import { useTheme } from '../../theme';
import { useT } from '../../i18n';
import { useUnreadConversations } from '../../data/inbox';
import { useUnreadNotifications } from '../../data/notifications';
import { Icon, type IconName } from '../../ui';

function HeaderButton({
  icon,
  label,
  onPress,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
}) {
  const th = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{
        minWidth: th.targetMin,
        minHeight: th.targetMin,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name={icon} color={th.colors.text} />
    </Pressable>
  );
}

export default function TabsLayout() {
  const th = useTheme();
  const t = useT();
  const router = useRouter();
  const unreadChats = useUnreadConversations().data?.conversations ?? 0;
  const unreadNotes = useUnreadNotifications().data?.total ?? 0;
  const icon =
    (name: IconName) =>
    ({ color }: { color: ColorValue }) => <Icon name={name} color={String(color)} />;
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: th.colors.surface },
        headerTintColor: th.colors.text,
        headerTitleStyle: { color: th.colors.text },
        tabBarStyle: {
          backgroundColor: th.colors.surface,
          borderTopColor: th.colors.border,
          minHeight: 56,
        },
        tabBarActiveTintColor: th.colors.primaryText,
        tabBarInactiveTintColor: th.colors.textMuted,
        tabBarLabelStyle: { fontSize: th.fontSize.xs },
        sceneStyle: { backgroundColor: th.colors.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('nav.home'),
          tabBarIcon: icon('home'),
          tabBarAccessibilityLabel: t('nav.home'),
          headerRight: () => (
            <View style={{ flexDirection: 'row' }}>
              <HeaderButton
                icon="search"
                label={t('a11y.searchButton')}
                onPress={() => router.push('/search')}
              />
              <HeaderButton
                icon="plus"
                label={t('a11y.composeButton')}
                onPress={() => router.push('/compose')}
              />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="communities"
        options={{
          title: t('nav.communities'),
          tabBarIcon: icon('users'),
          tabBarAccessibilityLabel: t('nav.communities'),
        }}
      />
      <Tabs.Screen
        name="inbox"
        options={{
          title: t('nav.inbox'),
          tabBarIcon: icon('mail'),
          tabBarBadge: unreadChats > 0 ? (unreadChats > 99 ? '99+' : unreadChats) : undefined,
          tabBarAccessibilityLabel:
            unreadChats > 0
              ? `${t('nav.inbox')}, ${t('nav.unreadBadge', { count: unreadChats })}`
              : t('nav.inbox'),
          headerRight: () => (
            <HeaderButton
              icon="plus"
              label={t('inbox.new')}
              onPress={() => router.push('/new-message')}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: t('nav.notifications'),
          tabBarIcon: icon('bell'),
          tabBarBadge: unreadNotes > 0 ? (unreadNotes > 99 ? '99+' : unreadNotes) : undefined,
          tabBarAccessibilityLabel:
            unreadNotes > 0
              ? `${t('nav.notifications')}, ${t('nav.unreadBadge', { count: unreadNotes })}`
              : t('nav.notifications'),
        }}
      />
      <Tabs.Screen
        name="me"
        options={{
          title: t('nav.profile'),
          tabBarIcon: icon('user'),
          tabBarAccessibilityLabel: t('nav.profile'),
          headerRight: () => (
            <HeaderButton
              icon="settings"
              label={t('a11y.settingsButton')}
              onPress={() => router.push('/settings')}
            />
          ),
        }}
      />
    </Tabs>
  );
}
