import { router, type Href } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useT } from '../../lib/i18n';
import { hasStudio } from '../../lib/creator';
import { useFlag } from '../../lib/flags';
import { useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import { ProfileView } from '../../lib/profile';
import { Icon, Loading, Notice, Screen, useColors, useTabBarSpace, type IconName } from '../../lib/ui';

/**
 * You: your profile, with "Your space" on top: everything that is yours to come back to (saved
 * posts and boards, drafts, your archive, memories, recap videos, circles, close friends, events,
 * communities, Together, Live), Studio for creator, professional and business accounts, your
 * purchases, finding and inviting friends, Real and Settings. Memories, Together and Live show when
 * their features are on. Then your chapters and posts.
 */
export default function ProfileScreen() {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const bottom = useTabBarSpace();
  const memories = useFlag('MEMORY');
  const together = useFlag('REAL_TOGETHER');
  const live = useFlag('LIVE');
  const squadsOn = useFlag('SQUADS');

  if (me === null)
    return (
      <Screen>
        <Notice>{t('m.common.signedOut')}</Notice>
      </Screen>
    );
  if (!me) return <Loading />;
  const shortcuts: { label: string; icon: IconName; href: Href; on?: boolean }[] = [
    { label: t('m.saved.title'), icon: 'bookmark-outline', href: '/saved' },
    { label: t('m.drafts.title'), icon: 'document-text-outline', href: '/drafts' },
    { label: t('m.you.archive'), icon: 'archive-outline', href: '/archive' },
    { label: t('memories.title'), icon: 'images-outline', href: '/memories', on: memories === true },
    { label: t('m.you.recaps'), icon: 'film-outline', href: '/recaps' },
    { label: t('squads.title'), icon: 'people-outline', href: '/squads', on: squadsOn !== false },
    { label: t('m.circles.title'), icon: 'ellipse-outline', href: '/circles' },
    { label: t('m.closeFriends.title'), icon: 'star-outline', href: '/close-friends' },
    { label: t('events.title'), icon: 'calendar-outline', href: '/events' },
    { label: t('tickets.title'), icon: 'ticket-outline', href: '/tickets' },
    { label: t('communities.title'), icon: 'people-circle-outline', href: '/communities' },
    { label: t('m.together.title'), icon: 'aperture-outline', href: '/together', on: together === true },
    { label: t('m.live.title'), icon: 'radio-outline', href: '/live', on: live === true },
    { label: t('friends.title'), icon: 'people-outline', href: '/find-friends' },
    { label: t('invite.title'), icon: 'gift-outline', href: '/invite' },
    { label: t('m.studio.title'), icon: 'stats-chart-outline', href: '/studio', on: hasStudio(me.mode) },
    { label: t('m.purchases.title'), icon: 'bag-handle-outline', href: '/purchases' },
    { label: t('m.drops.yours'), icon: 'pricetags-outline', href: '/drops' },
    { label: t('mixes.yours'), icon: 'list-outline', href: '/mixes' },
    { label: t('plus.title'), icon: 'sparkles-outline', href: '/plus' },
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
            {shortcuts
              .filter((s) => s.on !== false)
              .map((s) => (
                <Shortcut key={String(s.href)} label={s.label} icon={s.icon} href={s.href} />
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
      {/* Two lines rather than shrinking a long label (in French or Swahili, say) to a size nobody can read. */}
      <Text style={{ color: c.ink, fontSize: 12, lineHeight: 15, fontWeight: '600', textAlign: 'center' }} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}
