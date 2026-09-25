import React, { useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { Image } from 'expo-image';
import type { PostMedia } from '@yapilapi/api-client';
import { API_URL } from '../config';
import { useTheme } from '../theme';
import { usePrefs } from '../prefs';
import { useT } from '../i18n';
import { AppText, Icon } from '../ui';

export const absoluteUrl = (u: string) =>
  /^https?:\/\//i.test(u) ? u : `${API_URL.replace(/\/+$/, '')}${u.startsWith('/') ? '' : '/'}${u}`;

/**
 * One attachment. Images honour low-data mode (tap to load) and always carry alt text for screen readers. Video and audio
 * never autoplay and never stream inside the feed: the tile opens the file in the system player/browser on demand.
 */
export function MediaItem({ media, single }: { media: PostMedia; single: boolean }) {
  const th = useTheme();
  const t = useT();
  const { lowBandwidth } = usePrefs();
  const [loadAnyway, setLoadAnyway] = useState(false);
  const ratio =
    media.width && media.height ? Math.min(Math.max(media.width / media.height, 0.75), 1.9) : 4 / 3;
  const box = {
    borderRadius: th.radius.sm,
    overflow: 'hidden' as const,
    backgroundColor: th.colors.surfaceSunken,
    aspectRatio: single ? ratio : 1,
    flex: 1,
  };
  const alt = media.altText?.trim();

  if (media.status === 'uploaded' || media.status === 'processing') {
    return (
      <View style={[box, { alignItems: 'center', justifyContent: 'center' }]}>
        <AppText variant="caption" tone="muted">
          {t('post.mediaProcessing')}
        </AppText>
      </View>
    );
  }

  if (media.kind === 'image') {
    if (lowBandwidth && !loadAnyway) {
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            alt
              ? t('post.imageAlt', { alt: `${alt}. ${t('post.tapToLoadImage')}` })
              : t('post.tapToLoadImage')
          }
          onPress={() => setLoadAnyway(true)}
          style={[box, { alignItems: 'center', justifyContent: 'center', gap: th.space[2] }]}
        >
          <Icon name="image" color={th.colors.textMuted} size={28} />
          <AppText variant="caption" tone="muted">
            {t('post.tapToLoadImage')}
          </AppText>
        </Pressable>
      );
    }
    return (
      <View style={box}>
        <Image
          source={{ uri: absoluteUrl(media.url) }}
          placeholder={media.blurhash ? { blurhash: media.blurhash } : undefined}
          contentFit="cover"
          transition={0}
          style={{ width: '100%', height: '100%' }}
          accessible
          accessibilityRole="image"
          accessibilityLabel={alt ? t('post.imageAlt', { alt }) : t('post.image')}
          cachePolicy="disk"
        />
      </View>
    );
  }

  const label =
    media.kind === 'video'
      ? t('post.video')
      : media.kind === 'audio'
        ? t('post.audio')
        : t('post.file');
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={
        media.kind === 'video' ? t('post.videoOpen') : `${label}. ${alt ?? ''}`.trim()
      }
      onPress={() => {
        void Linking.openURL(absoluteUrl(media.url));
      }}
      style={[
        box,
        {
          alignItems: 'center',
          justifyContent: 'center',
          gap: th.space[2],
          minHeight: th.targetMin * 2,
        },
      ]}
    >
      <Icon name="play" color={th.colors.textMuted} size={28} />
      <AppText variant="label" tone="muted">
        {label}
      </AppText>
    </Pressable>
  );
}

export function MediaGrid({ media }: { media: PostMedia[] }) {
  const th = useTheme();
  if (!media.length) return null;
  const shown = media.slice(0, 4);
  if (shown.length === 1)
    return (
      <View style={{ marginTop: th.space[3] }}>
        <MediaItem media={shown[0]!} single />
      </View>
    );
  return (
    <View
      style={{ marginTop: th.space[3], flexDirection: 'row', flexWrap: 'wrap', gap: th.space[1] }}
    >
      {shown.map((m) => (
        <View key={m.id} style={{ width: '49%' }}>
          <MediaItem media={m} single={false} />
        </View>
      ))}
    </View>
  );
}
