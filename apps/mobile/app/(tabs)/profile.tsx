import { router, type Href } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useT } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import { ProfileView } from '../../lib/profile';
import { Icon, Loading, Notice, Screen, useColors, useTabBarSpace, type IconName } from '../../lib/ui';

/**
 * You: your profile, with "Your space" on top: everything that is yours to come back to (saved
 * posts and boards, drafts, your archive, recap videos, circles, close friends, events,
 * communities), finding and inviting friends, Real and Settings. Then your chapters and posts.
 */
export default function ProfileScreen() {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const bottom = useTabBarSpace();

  if (me === null)
    return (
      <Screen>
        <Notice>{t('m.common.signedOut')}</Notice>
      </Screen>
    );
  if (!me) return <Loading />;
  const shortcuts: { label: string; icon: IconName; href: Href }[] = [
    { label: t('m.saved.title'), icon: 'bookmark-outline', href: '/saved' },
    { label: t('m.drafts.title'), icon: 'document-text-outline', href: '/drafts' },
    { label: t('m.you.archive'), icon: 'archive-outline', href: '/archive' },
    { label: t('m.you.recaps'), icon: 'film-outline', href: '/recaps' },
    { label: t('m.circles.title'), icon: 'ellipse-outline', href: '/circles' },
    { label: t('m.closeFriends.title'), icon: 'star-outline', href: '/close-friends' },
    { label: t('events.title'), icon: 'calendar-outline', href: '/events' },
    { label: t('communities.title'), icon: 'people-circle-outline', href: '/communities' },
    { label: t('friends.title'), icon: 'people-outline', href: '/find-friends' },
    { label: t('invite.title'), icon: 'gift-outline', href: '/invite' },
    { label: t('m.title.real'), icon: 'camera-outline', href: '/real' },
    { label: t('m.title.settings'), icon: 'settings-outline', href: '/settings' },
  ];
  return (
    <ProfileView
      username={me.username}
      bottom={bottom}
      actions={
        <View style={{ gap: space[2] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
            {t('m.you.space')}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: space[3] }}>
            {shortcuts.map((s) => (
              <Shortcut key={String(s.href)} {...s} />
            ))}
          </View>
        </View>
      }
    />
  );
}

function Shortcut({ label, icon, href }: { label: string; icon: IconName; href: Href }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => router.push(href)}
      style={({ pressed }) => ({ width: '25%', alignItems: 'center', gap: 6, paddingHorizontal: 2, opacity: pressed ? 0.7 : 1 })}
    >
      <View style={{ width: 52, height: 52, borderRadius: radius.lg, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={24} color={c.yapi} />
      </View>
      <Text style={{ color: c.ink, fontSize: 12, fontWeight: '600', textAlign: 'center' }} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
        {label}
      </Text>
    </Pressable>
  );
}
