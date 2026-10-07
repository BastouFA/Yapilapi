import { Text, View } from 'react-native';
import { compactCount } from '../../../packages/shared/src/post-stats';
import type { Post } from '../../../packages/shared/src/types';
import { useT } from './i18n';
import { radius, space } from './theme';
import { Avatar, Icon, useColors, userText } from './ui';

/**
 * The quiet numbers under a post card (docs/product/post-stats.md): views and shares (likes,
 * comments and reposts are on the buttons above), the Rising badge, "Liked by Amara and 12
 * others", and on your own post with hidden counts, that only you can see them. Short numbers
 * on screen, full ones for screen readers.
 */
export function PostStats({ post, isAuthor }: { post: Post; isAuthor: boolean }) {
  const c = useColors();
  const { t, tp, locale } = useT();
  const views = post.counts.views;
  const shares = post.counts.shares ?? 0;
  const parts: string[] = [];
  if (views) parts.push(tp('post.stats.views', views));
  if (shares) parts.push(tp('post.stats.shares', shares));
  if (post.rising) parts.push(t('post.rising.label'));
  const likedBy = post.likedBy;
  const onlyYou = isAuthor && post.countsHidden;
  if (!parts.length && !likedBy && !onlyYou) return null;
  const muted = { color: c.inkMuted, fontSize: 13, fontWeight: '600' } as const;
  return (
    <View style={{ gap: space[2] }}>
      {likedBy ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
          <Avatar name={likedBy.user.displayName} url={likedBy.user.avatarUrl} size={20} />
          <Text style={[{ color: c.ink, fontSize: 13, lineHeight: 18, flexShrink: 1 }, userText]} numberOfLines={2}>
            {likedBy.others
              ? tp('post.likedBy.others', likedBy.others, { name: likedBy.user.displayName })
              : t('post.likedBy', { name: likedBy.user.displayName })}
          </Text>
        </View>
      ) : null}
      {parts.length ? (
        // One stop for screen readers: "Views and shares: 1,234 views, 5 shares".
        <View
          accessible
          accessibilityLabel={`${t('post.stats.label')}: ${parts.join(', ')}`}
          style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space[3], rowGap: space[1] }}
        >
          {views ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Icon name="eye-outline" size={14} color={c.inkMuted} />
              <Text style={muted}>{compactCount(views, locale)}</Text>
            </View>
          ) : null}
          {shares ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Icon name="paper-plane-outline" size={13} color={c.inkMuted} directional />
              <Text style={muted}>{compactCount(shares, locale)}</Text>
            </View>
          ) : null}
          {post.rising ? <RisingBadge /> : null}
        </View>
      ) : null}
      {onlyYou ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="eye-off-outline" size={14} color={c.inkMuted} />
          <Text style={{ color: c.inkMuted, fontSize: 12, lineHeight: 16, flexShrink: 1 }}>{t('post.stats.onlyYou')}</Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * "Rising": the post's momentum is in the top few percent right now. `onMedia` is the white
 * version over a reel's video.
 */
export function RisingBadge({ onMedia, labelled }: { onMedia?: boolean; labelled?: boolean }) {
  const c = useColors();
  const { t } = useT();
  const fg = onMedia ? '#FFFFFF' : c.yapi;
  return (
    <View
      // Inside a labelled group it is read with the group; on its own it says what it means.
      accessible={labelled}
      accessibilityLabel={labelled ? t('post.rising.label') : undefined}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: radius.full,
        backgroundColor: onMedia ? 'rgba(5,6,11,0.55)' : c.yapiSoft,
        borderWidth: onMedia ? 1 : 0,
        borderColor: 'rgba(255,255,255,0.5)',
      }}
    >
      <Icon name="trending-up" size={12} color={fg} />
      <Text style={{ color: fg, fontSize: 11, fontWeight: '800' }} numberOfLines={1}>
        {t('post.rising')}
      </Text>
    </View>
  );
}
