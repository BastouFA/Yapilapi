import { Stack } from 'expo-router';
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
 * Tabs live in (tabs); detail screens (chat, post, community, event, place, settings, Real, Reels) push on top.
 * Links from outside (yapilapi://…, web paths) are mapped in +native-intent.tsx; push taps in useNotificationLinks.
 */
function Screens() {
  const c = useColors();
  const { t } = useT();
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
        <Stack.Screen name="now-status" options={{ title: t('m.now.title'), presentation: 'modal' }} />
        <Stack.Screen name="archive" options={{ title: t('m.archive.title') }} />
        <Stack.Screen name="drafts" options={{ title: t('m.drafts.title') }} />
        <Stack.Screen name="recaps" options={{ title: t('m.recap.title') }} />
        <Stack.Screen name="recap-new" options={{ title: t('m.recap.new') }} />
        <Stack.Screen name="chapter/[id]" options={{ title: t('m.chapters.title') }} />
        <Stack.Screen name="chapter-edit" options={{ title: t('m.chapters.new'), presentation: 'modal' }} />
        <Stack.Screen name="saved" options={{ title: t('m.saved.title') }} />
        <Stack.Screen name="board/[id]" options={{ title: t('m.boards.board') }} />
        <Stack.Screen name="board-edit" options={{ title: t('m.boards.new'), presentation: 'modal' }} />
        <Stack.Screen name="invite" options={{ title: t('invite.title') }} />
        <Stack.Screen name="find-friends" options={{ title: t('friends.title') }} />
        <Stack.Screen name="onboarding" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="c/[slug]" options={{ title: t('m.title.community') }} />
        <Stack.Screen name="room/[id]" options={{ title: t('m.rooms.title') }} />
        <Stack.Screen name="settings" options={{ title: t('m.title.settings') }} />
        <Stack.Screen name="notifications" options={{ title: t('notifications.title') }} />
        <Stack.Screen name="real" options={{ title: t('m.title.real') }} />
        <Stack.Screen name="assistant" options={{ title: t('m.title.assistant') }} />
        <Stack.Screen name="events" options={{ title: t('events.title') }} />
        <Stack.Screen name="event/[id]" options={{ title: t('m.event.title') }} />
        <Stack.Screen name="place/[id]" options={{ title: t('m.place.title') }} />
        <Stack.Screen name="communities" options={{ title: t('communities.title') }} />
        <Stack.Screen name="community-new" options={{ title: t('communities.create'), presentation: 'modal' }} />
        <Stack.Screen name="community-settings" options={{ title: t('m.manage.title') }} />
        <Stack.Screen name="event-edit" options={{ title: t('events.create'), presentation: 'modal' }} />
        <Stack.Screen name="plus" options={{ title: t('plus.title') }} />
        <Stack.Screen name="follows" options={{ title: t('profile.followers') }} />
        <Stack.Screen name="profile-edit" options={{ title: t('profile.edit'), presentation: 'modal' }} />
        <Stack.Screen name="reels" options={{ title: t('m.title.reels'), headerShown: false, contentStyle: { backgroundColor: '#000' } }} />
        <Stack.Screen name="new-group" options={{ title: t('m.inbox.newGroup'), presentation: 'modal' }} />
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
