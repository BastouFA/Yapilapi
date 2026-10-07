import { useEventListener } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useState } from 'react';
import { Image, Modal, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MediaItem, Post } from '../../../packages/shared/src/types';
import { client, errorMessage, mediaUrl } from './api';
import { Slider } from './editor';
import { useT } from './i18n';
import { pickOne, uploadPicked, type Picked } from './media';
import { radius, space } from './theme';
import { Button, Notice, useColors } from './ui';

/** "0:02.5": a moment to a tenth of a second, as the web cover editor shows it. */
const moment = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};

/** The part of a W × H photo in the video's shape (width / height), `at` (0 to 1) along the side that has room. */
export function coverCrop(W: number, H: number, ratio: number, at: number) {
  if (W / H > ratio) {
    const w = (ratio * H) / W;
    return { x: (1 - w) * at, y: 0, w, h: 1 };
  }
  const h = W / ratio / H;
  return { x: 0, y: (1 - h) * at, w: 1, h };
}

/**
 * The cover of a video already posted (a reel, or a video in a post): any moment of it, one of
 * your photos cut to the video's shape, or the default. Each choice is saved as it is made
 * (PUT /v1/posts/:id/cover), and `onSaved` gets the updated post.
 */
export function VideoCoverEditor({ post, media, onSaved, onClose }: { post: Post; media: MediaItem; onSaved: (p: Post) => void; onClose: () => void }) {
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const [current, setCurrent] = useState(media);
  const [duration, setDuration] = useState(0);
  const [at, setAt] = useState((media.coverMs ?? 0) / 1000);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [photo, setPhoto] = useState<Picked | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  // The poster is the right way up (a phone video's stored size may be sideways), and a cover keeps the video's shape.
  const [ratio, setRatio] = useState(media.width && media.height ? media.width / media.height : 9 / 16);
  useEffect(() => {
    const p = media.posterUrl ?? media.variants?.thumb;
    if (p)
      Image.getSize(
        mediaUrl(p),
        (w, h) => w && h && setRatio(w / h),
        () => undefined,
      );
  }, [media.posterUrl, media.variants?.thumb]);
  const player = useVideoPlayer(mediaUrl(media.variants?.mp4 ?? media.url), (p) => {
    p.muted = true;
    p.loop = false;
  });
  useEventListener(player, 'statusChange', ({ status }) => {
    if (status !== 'readyToPlay' || duration) return;
    const d = Number.isFinite(player.duration) ? player.duration : 0;
    setDuration(d);
    player.currentTime = Math.min(at, d);
  });

  async function save(kind: 'frame' | 'photo' | 'default', run: (api: Awaited<ReturnType<typeof client>>) => Promise<{ post: Post }>) {
    setError(null);
    try {
      const { post: updated } = await run(await client());
      const m = updated.media.find((x) => x.id === media.id);
      if (m) setCurrent(m);
      onSaved(updated);
      setStage(t(kind === 'default' ? 'postCover.backToDefault' : 'postCover.saved'));
    } catch (e) {
      setError(errorMessage(e));
      setStage(null);
    }
  }

  const fit = box.width ? Math.min(box.width / ratio, box.height) : 0;
  const poster = current.posterUrl ?? current.variants?.thumb ?? null;
  if (photo)
    return (
      <PhotoCrop
        photo={photo}
        ratio={ratio}
        onCancel={() => setPhoto(null)}
        onDone={(crop) => {
          const picked = photo;
          setPhoto(null);
          setStage(t('profilePlus.uploading'));
          void save('photo', async (api) => {
            const up = await uploadPicked(picked);
            setStage(t('m.cover.preparing'));
            return api.posts.setCoverWhenReady(post.id, { mediaId: media.id, imageMediaId: up.id, crop });
          });
        }}
      />
    );
  return (
    <Modal animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: c.ground, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[3], paddingVertical: space[2] }}>
          <Text accessibilityRole="header" numberOfLines={1} style={{ flex: 1, color: c.ink, fontWeight: '700', fontSize: 16 }}>
            {t('postCover.edit')}
          </Text>
          <Button label={t('m.common.done')} size="sm" onPress={onClose} />
        </View>
        <View
          style={{ flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center' }}
          onLayout={(e) => setBox({ width: e.nativeEvent.layout.width - space[3] * 2, height: e.nativeEvent.layout.height - space[3] * 2 })}
        >
          {fit ? (
            <VideoView
              player={player}
              style={{ width: fit * ratio, height: fit }}
              contentFit="contain"
              nativeControls={false}
              accessibilityLabel={t('postCover.preview')}
            />
          ) : null}
        </View>
        <ScrollView style={{ maxHeight: '45%' }} contentContainerStyle={{ padding: space[3], gap: space[3] }} keyboardShouldPersistTaps="handled">
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
            {poster ? (
              <Image
                source={{ uri: mediaUrl(poster) }}
                accessibilityLabel={t('postCover.current')}
                style={{ width: 44, height: 56, borderRadius: radius.sm, backgroundColor: c.surfaceSunken }}
              />
            ) : null}
            <Text accessibilityLiveRegion="polite" style={{ flex: 1, color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>
              {stage ?? (current.customCover ? t('postCover.customNow') : t('postCover.defaultNow'))}
            </Text>
          </View>
          <Slider
            label={t('postCover.moment')}
            value={Math.min(at, duration)}
            min={0}
            max={Math.max(0.1, duration)}
            step={0.1}
            format={moment}
            onChange={(v) => {
              setAt(v);
              player.pause();
              player.currentTime = v;
            }}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            <Button
              label={t('videoEditor.cover.useFrame')}
              size="sm"
              disabled={!duration}
              onPress={() => save('frame', (api) => api.posts.setCover(post.id, { mediaId: media.id, atMs: Math.round(at * 1000) }))}
            />
            <Button
              label={t('postCover.uploadPhoto')}
              variant="secondary"
              size="sm"
              icon="image"
              onPress={async () => {
                const picked = await pickOne(['images']);
                if (picked === 'denied') setError(t('m.create.photosPermission'));
                else if (picked) setPhoto(picked);
              }}
            />
            <Button
              label={t('videoEditor.cover.useDefault')}
              variant="ghost"
              size="sm"
              disabled={!current.customCover}
              onPress={() => save('default', (api) => api.posts.setCover(post.id, { mediaId: media.id, reset: true }))}
            />
          </View>
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('postCover.hint')}</Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

/** Where in a photo the cover is cut, in the video's shape: slide it along the side that has room. */
function PhotoCrop({
  photo,
  ratio,
  onDone,
  onCancel,
}: {
  photo: Picked;
  ratio: number;
  onDone: (crop: { x: number; y: number; w: number; h: number }) => void;
  onCancel: () => void;
}) {
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  const [at, setAt] = useState(0.5);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const W = photo.width || 1;
  const H = photo.height || 1;
  const crop = coverCrop(W, H, ratio, at);
  const scale = box.width ? Math.min(box.width / W, box.height / H) : 0;
  const shown = { width: W * scale, height: H * scale };
  const room = Math.abs(W / H - ratio) > 0.01;
  return (
    <Modal animationType="slide" presentationStyle="fullScreen" onRequestClose={onCancel}>
      <View style={{ flex: 1, backgroundColor: c.ground, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[3], paddingVertical: space[2] }}>
          <Button label={t('common.cancel')} variant="ghost" size="sm" onPress={onCancel} />
          <Text accessibilityRole="header" numberOfLines={1} style={{ flex: 1, color: c.ink, fontWeight: '700', fontSize: 16, textAlign: 'center' }}>
            {t('postCover.photoTitle')}
          </Text>
          <Button label={t('m.common.done')} size="sm" onPress={() => onDone(crop)} />
        </View>
        <View
          style={{ flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center' }}
          onLayout={(e) => setBox({ width: e.nativeEvent.layout.width - space[3] * 2, height: e.nativeEvent.layout.height - space[3] * 2 })}
        >
          {scale ? (
            <View style={shown}>
              <Image source={{ uri: photo.uri }} style={shown} accessibilityLabel={t('m.editor.preview')} />
              {/* Dimmed outside the part kept, with a frame around it. */}
              {[
                { left: 0, top: 0, width: shown.width, height: crop.y * shown.height },
                { left: 0, top: (crop.y + crop.h) * shown.height, width: shown.width, height: (1 - crop.y - crop.h) * shown.height },
                { left: 0, top: crop.y * shown.height, width: crop.x * shown.width, height: crop.h * shown.height },
                {
                  left: (crop.x + crop.w) * shown.width,
                  top: crop.y * shown.height,
                  width: (1 - crop.x - crop.w) * shown.width,
                  height: crop.h * shown.height,
                },
              ].map((r, i) => (
                <View key={i} pointerEvents="none" style={{ position: 'absolute', backgroundColor: 'rgba(0,0,0,0.55)', ...r }} />
              ))}
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: crop.x * shown.width,
                  top: crop.y * shown.height,
                  width: crop.w * shown.width,
                  height: crop.h * shown.height,
                  borderWidth: 2,
                  borderColor: '#fff',
                }}
              />
            </View>
          ) : null}
        </View>
        <View style={{ padding: space[3], gap: space[3] }}>
          {room ? (
            <Slider label={t('postCover.position')} value={at} min={0} max={1} step={0.01} onChange={setAt} format={(v) => `${Math.round(v * 100)}%`} />
          ) : null}
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('postCover.positionHint')}</Text>
        </View>
      </View>
    </Modal>
  );
}
