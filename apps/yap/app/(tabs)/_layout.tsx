import { Redirect, Tabs } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { client } from '../../../mobile/lib/api';
import { useT } from '../../../mobile/lib/i18n';
import { useRealtime, useSession } from '../../../mobile/lib/session';
import { Icon, Loading, useColors, type IconName } from '../../../mobile/lib/ui';

/** Unread messages across your chats, for the number on Chats. Refreshed when tabs change and on new messages. */
function useUnreadChats(signedIn: boolean, tab: number) {
  const [count, setCount] = useState(0);
  const load = useCallback(() => {
    if (!signedIn) return setCount(0);
    void client()
      .then((api) => api.conversations.list())
      .then(
        (r) => setCount(r.items.reduce((sum, c) => sum + c.unreadCount, 0)),
        () => {},
      );
  }, [signedIn]);
  useEffect(load, [load, tab]);
  useRealtime((e) => {
    if (['message.created', 'conversation.created', 'conversation.changed', 'conversation.removed', 'app.foreground'].includes(e.type)) load();
  });
  return count;
}

const ICONS: Record<string, [IconName, IconName]> = {
  index: ['chatbubbles', 'chatbubbles-outline'],
  calls: ['call', 'call-outline'],
  stories: ['aperture', 'aperture-outline'],
  settings: ['settings', 'settings-outline'],
};

/**
 * Yap's tabs, as in a messenger: Chats (with the unread count), Calls, Stories from the people you
 * follow, and Settings. Signed out, the welcome screen.
 */
export default function TabsLayout() {
  const c = useColors();
  const { t, number } = useT();
  const { me } = useSession();
  const [tab, setTab] = useState(0);
  const unread = useUnreadChats(!!me, tab);

  if (me === undefined) return <Loading />;
  if (me === null) return <Redirect href="/welcome" />;

  return (
    <Tabs
      screenListeners={{ state: (e) => setTab((e.data as { state?: { index?: number } }).state?.index ?? 0) }}
      screenOptions={({ route }) => ({
        headerStyle: { backgroundColor: c.ground },
        headerTintColor: c.ink,
        headerTitleStyle: { fontWeight: '800', fontSize: 20 },
        headerTitleAlign: 'left',
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: c.ground },
        tabBarActiveTintColor: c.yapi,
        tabBarInactiveTintColor: c.inkMuted,
        tabBarStyle: { backgroundColor: c.surface, borderTopColor: c.line },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
        tabBarIcon: ({ focused, color }) => <Icon name={ICONS[route.name]![focused ? 0 : 1]} size={24} color={String(color)} />,
      })}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('yapApp.tab.chats'),
          tabBarBadge: unread ? (unread > 99 ? '99+' : number(unread)) : undefined,
          tabBarBadgeStyle: { backgroundColor: c.yapi, color: c.onYapi, fontWeight: '700' },
          tabBarAccessibilityLabel: unread ? `${t('yapApp.tab.chats')}, ${t('m.inbox.unread', { count: unread })}` : t('yapApp.tab.chats'),
        }}
      />
      <Tabs.Screen name="calls" options={{ title: t('yapApp.tab.calls') }} />
      <Tabs.Screen name="stories" options={{ title: t('m.stories.label') }} />
      <Tabs.Screen name="settings" options={{ title: t('m.title.settings') }} />
    </Tabs>
  );
}
