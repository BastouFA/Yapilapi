import { router, Stack } from 'expo-router';
import { Pressable, Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { BoardsProvider } from '../lib/boards';
import { CallsProvider } from '../lib/calls';
import { DataSaverProvider } from '../lib/data-saver';
import { LocaleProvider, useT } from '../lib/i18n';
import { TranslationProvider } from '../lib/translation';
import { SessionProvider, useSession } from '../lib/session';
import { useColors } from '../lib/ui';
import { useUsageHeartbeat } from '../lib/usage';
import { YapPlayer } from '../lib/yaps';
import { useNotificationLinks } from '../lib/links';

function Heartbeat() {
  const { me } = useSession();
  useUsageHeartbeat(!!me);
  useNotificationLinks();
  return null;
}

/**
 * Tabs live in (tabs); detail screens (chat, post, community, event, place, settings, Real, Reels, memories,
 * Together, Live) push on top.
 * Links from outside (yapilapi://…, web paths) are mapped in +native-intent.tsx; push taps in useNotificationLinks.
 */
function Screens() {
  const c = useColors();
  const { t } = useT();
  // Sheets (modal screens) get a Cancel at the top, so there's always a way out besides swiping down.
  const closeButton = () => (
    <Pressable accessibilityRole="button" hitSlop={12} onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}>
      <Text style={{ color: c.yapi, fontSize: 17, fontWeight: '600' }}>{t('common.cancel')}</Text>
    </Pressable>
  );
  return (
    <>
      <StatusBar style={c.theme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: c.ground },
          headerTintColor: c.ink,
          headerTitleStyle: { fontWeight: '700' },
          headerShadowVisible: false,
          headerBackButtonDisplayMode: 'minimal',
          contentStyle: { backgroundColor: c.ground },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false, title: t('nav.home') }} />
        <Stack.Screen name="chat/[id]" options={{ title: t('m.title.conversation') }} />
        <Stack.Screen name="p/[id]" options={{ title: t('m.title.post') }} />
        <Stack.Screen name="u/[username]" options={{ title: t('m.title.profile') }} />
        <Stack.Screen name="t/[tag]" options={{ title: t('m.title.tag') }} />
        <Stack.Screen name="s/[id]" options={{ title: t('m.stories.label') }} />
        <Stack.Screen name="sounds/[id]" options={{ title: t('m.sound.title') }} />
        <Stack.Screen name="music/[id]" options={{ title: t('music.track.kind') }} />
        <Stack.Screen name="close-friends" options={{ title: t('m.closeFriends.title') }} />
        <Stack.Screen name="circles" options={{ title: t('m.circles.title') }} />
        <Stack.Screen name="circle/[id]" options={{ title: t('m.circles.title') }} />
        <Stack.Screen name="now-status" options={{ title: t('m.now.title'), presentation: 'modal', headerLeft: closeButton }} />
        <Stack.Screen name="archive" options={{ title: t('m.archive.title') }} />
        <Stack.Screen name="drafts" options={{ title: t('m.drafts.title') }} />
        <Stack.Screen name="recaps" options={{ title: t('m.recap.title') }} />
        <Stack.Screen name="recap-new" options={{ title: t('m.recap.new') }} />
        <Stack.Screen name="chapter/[id]" options={{ title: t('m.chapters.title') }} />
        <Stack.Screen name="chapter-edit" options={{ title: t('m.chapters.new'), presentation: 'modal', headerLeft: closeButton }} />
        <Stack.Screen name="saved" options={{ title: t('m.saved.title') }} />
        <Stack.Screen name="board/[id]" options={{ title: t('m.boards.board') }} />
        <Stack.Screen name="board-edit" options={{ title: t('m.boards.new'), presentation: 'modal', headerLeft: closeButton }} />
        <Stack.Screen name="invite" options={{ title: t('invite.title') }} />
        <Stack.Screen name="find-friends" options={{ title: t('friends.title') }} />
        <Stack.Screen name="onboarding" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="c/[slug]" options={{ title: t('m.title.community') }} />
        <Stack.Screen name="room/[id]" options={{ title: t('m.rooms.title') }} />
        <Stack.Screen name="settings" options={{ title: t('m.title.settings') }} />
        <Stack.Screen name="notifications" options={{ title: t('notifications.title') }} />
        <Stack.Screen name="real" options={{ title: t('m.title.real') }} />
        <Stack.Screen name="memories/index" options={{ title: t('memories.title') }} />
        <Stack.Screen name="memories/[id]" options={{ title: t('memories.title') }} />
        <Stack.Screen name="together/index" options={{ title: t('m.together.title') }} />
        <Stack.Screen name="together/[id]" options={{ title: t('m.together.title') }} />
        <Stack.Screen name="live/index" options={{ title: t('m.live.title') }} />
        <Stack.Screen name="live/[id]" options={{ title: t('m.live.title') }} />
        <Stack.Screen name="assistant" options={{ title: t('m.title.assistant') }} />
        <Stack.Screen name="events" options={{ title: t('events.title') }} />
        <Stack.Screen name="event/[id]" options={{ title: t('m.event.title') }} />
        <Stack.Screen name="place/[id]" options={{ title: t('m.place.title') }} />
        <Stack.Screen name="communities" options={{ title: t('communities.title') }} />
        <Stack.Screen name="follows" options={{ title: t('profile.followers') }} />
        <Stack.Screen name="profile-edit" options={{ title: t('profile.edit'), presentation: 'modal', headerLeft: closeButton }} />
        <Stack.Screen name="reels" options={{ title: t('m.title.reels'), headerShown: false, contentStyle: { backgroundColor: '#000' } }} />
        <Stack.Screen name="new-group" options={{ title: t('m.inbox.newGroup'), presentation: 'modal', headerLeft: closeButton }} />
        <Stack.Screen
          name="camera"
          options={{
            title: t('m.camera.title'),
            headerShown: false,
            presentation: 'fullScreenModal',
            animation: 'slide_from_bottom',
            contentStyle: { backgroundColor: '#000' },
          }}
        />
      </Stack>
    </>
  );
}

/** The language (and layout direction) depends on who is signed in, so it sits inside the session. */
export default function Root() {
  return (
    <SessionProvider>
      <DataSaverProvider>
        <LocaleProvider>
          <TranslationProvider>
            <CallsProvider>
              <BoardsProvider>
                <Heartbeat />
                <Screens />
                <YapPlayer />
              </BoardsProvider>
            </CallsProvider>
          </TranslationProvider>
        </LocaleProvider>
      </DataSaverProvider>
    </SessionProvider>
  );
}
