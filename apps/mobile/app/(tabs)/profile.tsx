import { router, type Href } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useT } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import { ProfileView } from '../../lib/profile';
import { Icon, Loading, Notice, Screen, useColors, useTabBarSpace, type IconName } from '../../lib/ui';

/** Your profile: counts, a row of shortcuts, then your chapters and posts. Push and sign out live in Settings. */
export default function ProfileScreen() {
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
    { label: t('friends.title'), icon: 'people-outline', href: '/find-friends' },
    { label: t('invite.title'), icon: 'gift-outline', href: '/invite' },
    { label: t('m.title.real'), icon: 'camera-outline', href: '/real' },
    { label: t('notifications.title'), icon: 'notifications-outline', href: '/notifications' },
    { label: t('m.title.settings'), icon: 'settings-outline', href: '/settings' },
  ];
  return (
    <ProfileView
      username={me.username}
      bottom={bottom}
      actions={
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space[2] }}>
          {shortcuts.map((s) => (
            <Shortcut key={String(s.href)} {...s} />
          ))}
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
      style={({ pressed }) => ({ flex: 1, alignItems: 'center', gap: 6, opacity: pressed ? 0.7 : 1 })}
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
