import { useVideoPlayer, VideoView } from 'expo-video';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Image, Linking, ScrollView, Text, View } from 'react-native';
import type { MessageKey } from '../../../../packages/shared/src/i18n';
import { client, errorMessage, mediaUrl } from '../../lib/api';
import { useT } from '../../lib/i18n';
import {
  clock,
  pickOne,
  PLUS_RESUMABLE_MAX_BYTES,
  PLUS_REEL_MAX_SECONDS,
  REEL_MAX_SECONDS,
  RESUMABLE_MAX_BYTES,
  uploadPicked,
  type Picked,
  type Uploaded,
} from '../../lib/media';
import { useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import { Button, Card, Field, Icon, Notice, Screen, Segmented, useColors, useTabBarSpace } from '../../lib/ui';

const VISIBILITY = [
  { id: 'public', label: 'visibility.public' },
  { id: 'followers', label: 'visibility.followers' },
  { id: 'friends', label: 'visibility.friends' },
  { id: 'private', label: 'visibility.private' },
  { id: 'subscribers', label: 'visibility.subscribers' },
] as const satisfies readonly { id: string; label: MessageKey }[];

const KINDS = [
  { id: 'post', label: 'm.create.mode.post', hint: 'm.create.hint.post' },
  { id: 'reel', label: 'm.create.mode.reel', hint: 'm.create.hint.reel' },
  { id: 'story', label: 'm.create.mode.story', hint: 'm.create.hint.story' },
] as const satisfies readonly { id: string; label: MessageKey; hint: MessageKey }[];

const EXPIRES = [
  { id: '1h', label: 'm.create.expires.1h' },
  { id: '24h', label: 'm.create.expires.24h' },
  { id: 'permanent', label: 'm.create.expires.permanent' },
] as const satisfies readonly { id: string; label: MessageKey }[];

type Kind = (typeof KINDS)[number]['id'];
type Visibility = (typeof VISIBILITY)[number]['id'];
type Attached = Uploaded & { local: string; seconds: number | null };

const kindFrom = (mode: string | undefined): Kind | null => (mode === 'reel' || mode === 'story' || mode === 'post' ? mode : null);

/** Create: a text post, a reel (one video up to 3 minutes) or a story, like the web composer. */
export default function Create() {
  const c = useColors();
  const { t, number } = useT();
  const { me } = useSession();
  const bottom = useTabBarSpace();
  const params = useLocalSearchParams<{ mode?: string }>();
  const [kind, setKind] = useState<Kind>(kindFrom(params.mode) ?? 'post');
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<Visibility>(kind === 'story' ? 'friends' : 'public');
  const [expiresIn, setExpiresIn] = useState<(typeof EXPIRES)[number]['id']>('24h');
  const [media, setMedia] = useState<Attached | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Posting for subscribers needs a subscription plan (set up in Studio on the web).
  const [hasPlans, setHasPlans] = useState(false);
  const uploading = progress !== null;
  useEffect(() => {
    if (!me) return;
    void client()
      .then((api) => api.economy.plans(me.id))
      .then((r) => setHasPlans(r.items.length > 0))
      .catch(() => {});
  }, [me]);

  function switchTo(k: Kind) {
    setKind(k);
    setError(null);
    setNote(null);
    // Keep only what the new kind can hold: a reel is a video, a post here is text only.
    setMedia((m) => (k === 'post' || (k === 'reel' && m?.kind !== 'video') ? null : m));
    if (k === 'story' && (visibility === 'public' || visibility === 'subscribers')) setVisibility('friends');
  }

  // Home ("Your story") and Reels ("Make a reel") open this tab in a given mode.
  useEffect(() => {
    const k = kindFrom(params.mode);
    if (!k) return;
    switchTo(k);
    // Clear it, so the same link works again after switching modes by hand.
    router.setParams({ mode: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.mode]);

  if (!me)
    return (
      <Screen>
        <Notice>{t('m.create.signedOut')}</Notice>
      </Screen>
    );

  async function choose() {
    setError(null);
    const asset = await pickOne(kind === 'reel' ? ['videos'] : ['images', 'videos'], me?.plus ? PLUS_REEL_MAX_SECONDS : REEL_MAX_SECONDS).catch(
      (e: unknown) => {
        setError(errorMessage(e));
        return null;
      },
    );
    if (asset === 'denied') return setDenied(true);
    setDenied(false);
    if (!asset) return;
    const check = validate(asset);
    if (check) return setError(check);
    setProgress(0);
    try {
      const m = await uploadPicked(asset, setProgress);
      setMedia({ ...m, local: asset.uri, seconds: asset.duration ? asset.duration / 1000 : null });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setProgress(null);
    }
  }

  function validate(asset: Picked): string | null {
    const video = asset.type === 'video';
    if (kind === 'reel' && !video) return t('m.create.notVideo');
    // Check the length before uploading a long file for nothing.
    const seconds = asset.duration ? asset.duration / 1000 : 0;
    const maxSeconds = me?.plus ? PLUS_REEL_MAX_SECONDS : REEL_MAX_SECONDS;
    if (kind === 'reel' && seconds > maxSeconds) return t('m.create.reelTooLongMinutes', { minutes: maxSeconds / 60, length: clock(seconds) });
    const maxBytes = me?.plus ? PLUS_RESUMABLE_MAX_BYTES : RESUMABLE_MAX_BYTES;
    if (asset.fileSize && asset.fileSize > maxBytes) return t('m.create.tooLargeSize', { size: Math.round(maxBytes / 1024 / 1024) });
    return null;
  }

  async function publish() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const api = await client();
      if (kind === 'story') {
        await api.moments.create({
          body: body.trim() || undefined,
          mediaId: media?.id,
          expiresIn,
          visibility: visibility === 'subscribers' ? 'friends' : visibility,
        });
        setBody('');
        setMedia(null);
        Alert.alert(t('m.create.storyShared'));
        router.navigate('/');
        return;
      }
      if (kind === 'reel') {
        const v = media!;
        const r = await api.posts.create({ format: 'reel', body, visibility, media: [{ id: v.id, url: mediaUrl(v.url), kind: 'video' }] });
        setBody('');
        setMedia(null);
        if (r.moderation) Alert.alert(r.moderation.message);
        router.push({ pathname: '/reels', params: { start: r.post.id } });
        return;
      }
      const r = await api.posts.create({ body, visibility });
      setBody('');
      if (r.moderation) setNote(r.moderation.message);
      else router.navigate('/');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const hint = KINDS.find((k) => k.id === kind)!.hint;
  const canPublish = !busy && !uploading && (kind === 'reel' ? media?.kind === 'video' : kind === 'story' ? !!body.trim() || !!media : !!body.trim());

  return (
    <ScrollView
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: bottom }}
      keyboardShouldPersistTaps="handled"
    >
      <Segmented label={t('m.create.mode')} options={KINDS.map((k) => ({ id: k.id, label: t(k.label) }))} value={kind} onChange={switchTo} />
      <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>{t(hint)}</Text>
      <Card style={{ gap: space[3] }}>
        <Field
          label={kind === 'reel' ? t('m.create.reel.caption') : kind === 'story' ? t('m.create.story.body') : t('create.placeholder')}
          value={body}
          onChangeText={setBody}
          multiline
          maxLength={kind === 'story' ? 500 : kind === 'reel' ? 2200 : 5000}
          style={{ minHeight: kind === 'post' ? 140 : 96, textAlignVertical: 'top', paddingTop: 12 }}
        />

        {kind !== 'post' ? (
          <View style={{ gap: space[2] }}>
            {media ? <Preview media={media} onRemove={() => setMedia(null)} /> : null}
            <Button
              label={
                uploading
                  ? t('m.create.uploading', { progress: number(progress ?? 0, { style: 'percent' }) })
                  : kind === 'reel'
                    ? media
                      ? t('m.create.replaceVideo')
                      : t('m.create.chooseVideo')
                    : media
                      ? t('m.create.replaceMedia')
                      : t('m.create.choosePhotoVideo')
              }
              icon={kind === 'reel' ? 'videocam-outline' : 'image-outline'}
              variant="secondary"
              size="sm"
              disabled={uploading || busy}
              onPress={() => void choose()}
              style={{ alignSelf: 'flex-start' }}
            />
            {denied ? (
              <Notice tone="warn">
                <Text style={{ color: c.ink, lineHeight: 20 }}>{t('m.create.photosPermission')}</Text>
                <Button
                  label={t('m.common.openSettings')}
                  size="sm"
                  variant="secondary"
                  onPress={() => void Linking.openSettings()}
                  style={{ alignSelf: 'flex-start' }}
                />
              </Notice>
            ) : null}
          </View>
        ) : null}

        {kind === 'story' ? (
          <>
            <Text style={{ color: c.ink, fontWeight: '600' }}>{t('m.create.expires')}</Text>
            <Segmented
              label={t('m.create.expires')}
              options={EXPIRES.map((e) => ({ id: e.id, label: t(e.label) }))}
              value={expiresIn}
              onChange={setExpiresIn}
            />
          </>
        ) : null}

        <Text style={{ color: c.ink, fontWeight: '600' }}>{t('create.visibility')}</Text>
        <Segmented
          label={t('create.visibility')}
          options={VISIBILITY.filter((v) => v.id !== 'subscribers' || (hasPlans && kind !== 'story')).map((v) => ({ id: v.id, label: t(v.label) }))}
          value={visibility}
          onChange={setVisibility}
        />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {note ? <Notice>{note}</Notice> : null}
        <Button
          label={
            busy ? t('m.create.publishing') : kind === 'story' ? t('m.create.shareStory') : kind === 'reel' ? t('m.create.publishReel') : t('create.publish')
          }
          disabled={!canPublish}
          onPress={() => void publish()}
        />
      </Card>
      {kind === 'post' ? <Button label={t('m.real.capture')} icon="camera-outline" variant="secondary" onPress={() => router.push('/real')} /> : null}
    </ScrollView>
  );
}

/** The chosen photo or video, from the phone's copy so it shows at once. */
function Preview({ media, onRemove }: { media: Attached; onRemove: () => void }) {
  const c = useColors();
  const { t } = useT();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
      <View style={{ width: 72, height: 96, borderRadius: radius.md, overflow: 'hidden', backgroundColor: c.surfaceSunken }}>
        {media.kind === 'video' ? (
          <VideoPreview uri={media.local} />
        ) : (
          <Image source={{ uri: media.local }} accessibilityLabel={t('m.create.selectedPhoto')} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
        )}
      </View>
      <View style={{ flex: 1, gap: space[1] }}>
        {media.kind === 'video' ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name="videocam" size={16} color={c.inkMuted} />
            <Text style={{ color: c.inkMuted, fontSize: 13 }}>
              {media.seconds !== null ? t('m.create.videoLength', { length: clock(media.seconds) }) : t('m.create.video')}
            </Text>
          </View>
        ) : null}
        <Button label={t('m.common.remove')} variant="ghost" size="sm" icon="close" onPress={onRemove} style={{ alignSelf: 'flex-start' }} />
      </View>
    </View>
  );
}

function VideoPreview({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.muted = true;
    p.loop = true;
    p.play();
  });
  return <VideoView player={player} style={{ width: '100%', height: '100%' }} contentFit="cover" nativeControls={false} />;
}
