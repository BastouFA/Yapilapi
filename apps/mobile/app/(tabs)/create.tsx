import { useVideoPlayer, VideoView } from 'expo-video';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Image, Linking, ScrollView, Text, View } from 'react-native';
import type { EditorParamsInput } from '../../../../packages/shared/src/filters';
import type { MessageKey } from '../../../../packages/shared/src/i18n';
import type { Sound } from '../../../../packages/shared/src/types';
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
import { PhotoEditor, VideoEditor } from '../../lib/editor';
import { useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import { Button, Card, Field, Icon, Notice, Screen, Segmented, SwitchRow, useColors, useTabBarSpace, userText } from '../../lib/ui';
import { isVerificationError, VerifyPrompt } from '../../lib/safety';

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

/**
 * Create: a text post, a reel (one video up to 3 minutes, optionally with a sound from the
 * sound page) or a story (optionally for close friends only), like the web composer.
 */
export default function Create() {
  const c = useColors();
  const { t, number } = useT();
  const { me } = useSession();
  const bottom = useTabBarSpace();
  const params = useLocalSearchParams<{ mode?: string; sound?: string }>();
  const [kind, setKind] = useState<Kind>(kindFrom(params.mode) ?? 'post');
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<Visibility>(kind === 'story' ? 'friends' : 'public');
  const [expiresIn, setExpiresIn] = useState<(typeof EXPIRES)[number]['id']>('24h');
  const [media, setMedia] = useState<Attached | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [needsVerify, setNeedsVerify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sound, setSound] = useState<Sound | null>(null);
  const [closeFriends, setCloseFriends] = useState(false);
  // Posting for subscribers needs a subscription plan (set up in Studio on the web).
  const [hasPlans, setHasPlans] = useState(false);
  const [editing, setEditing] = useState<Picked | null>(null);
  const [applying, setApplying] = useState(false);
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

  // "Use this sound" on a sound page opens this tab as a reel with that sound.
  useEffect(() => {
    if (!params.sound) return;
    const soundId = params.sound;
    router.setParams({ sound: '' });
    client()
      .then((api) => api.sounds.get(soundId))
      .then(
        (r) => setSound(r.sound),
        (e) => setError(errorMessage(e)),
      );
  }, [params.sound]);

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
    // Photos (not GIFs) and videos open in the editor first.
    if (asset.type === 'video' || (asset.type === 'image' && asset.mimeType !== 'image/gif')) setEditing(asset);
    else void upload(asset, null);
  }

  /** Upload the picked (or edited) file, then have the server apply the look, trim and the rest. */
  async function upload(asset: Picked, edits: EditorParamsInput | null) {
    setProgress(0);
    try {
      const m = await uploadPicked(asset, setProgress);
      const seconds = asset.duration ? asset.duration / 1000 : null;
      if (!edits) return setMedia({ ...m, local: asset.uri, seconds });
      setApplying(true);
      const api = await client();
      const started = await api.media.edit(m.id, edits);
      const done = await api.media.waitUntilReady(started.media.id);
      const url = done.kind === 'video' ? (done.variants.mp4 ?? done.url) : (done.variants.large ?? done.variants.medium ?? done.url);
      setMedia({ id: done.id, kind: m.kind, url, local: mediaUrl(url), seconds: done.durationMs ? done.durationMs / 1000 : seconds });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setApplying(false);
      setProgress(null);
    }
  }

  function validate(asset: Picked): string | null {
    const video = asset.type === 'video';
    if (kind === 'reel' && !video) return t('m.create.notVideo');
    // A reel longer than the limit opens in the editor, which keeps a part that fits.
    const maxBytes = me?.plus ? PLUS_RESUMABLE_MAX_BYTES : RESUMABLE_MAX_BYTES;
    if (asset.fileSize && asset.fileSize > maxBytes) return t('m.create.tooLargeSize', { size: Math.round(maxBytes / 1024 / 1024) });
    return null;
  }

  async function publish() {
    setBusy(true);
    setError(null);
    setNote(null);
    setNeedsVerify(false);
    try {
      const api = await client();
      if (kind === 'story') {
        await api.moments.create({
          body: body.trim() || undefined,
          mediaId: media?.id,
          expiresIn,
          visibility: closeFriends ? 'close_friends' : visibility === 'subscribers' ? 'friends' : visibility,
        });
        setBody('');
        setMedia(null);
        Alert.alert(t('m.create.storyShared'));
        router.navigate('/');
        return;
      }
      if (kind === 'reel') {
        const v = media!;
        const r = await api.posts.create({
          format: 'reel',
          body,
          visibility,
          media: [{ id: v.id, url: mediaUrl(v.url), kind: 'video' }],
          ...(sound ? { soundId: sound.id } : {}),
        });
        setBody('');
        setMedia(null);
        setSound(null);
        if (r.moderation) Alert.alert(r.moderation.message);
        router.push({ pathname: '/reels', params: { start: r.post.id } });
        return;
      }
      const r = await api.posts.create({ body, visibility });
      setBody('');
      if (r.moderation) setNote(r.moderation.message);
      else router.navigate('/');
    } catch (e) {
      if (isVerificationError(e)) setNeedsVerify(true);
      else setError(errorMessage(e));
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
                applying
                  ? t('m.editor.applying')
                  : uploading
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

        {kind === 'reel' && sound ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <Icon name="musical-notes" size={18} color={c.ink} />
            <Text style={[{ color: c.ink, fontWeight: '600', flex: 1 }, userText]} numberOfLines={2}>
              {t('m.create.sound', { title: sound.title })}
            </Text>
            <Button label={t('m.create.ownSound')} variant="ghost" size="sm" onPress={() => setSound(null)} />
          </View>
        ) : null}

        {kind === 'story' ? (
          <>
            <SwitchRow label={t('m.closeFriends.title')} hint={t('m.closeFriends.storyHint')} value={closeFriends} onValueChange={setCloseFriends} />
            <Button
              label={t('m.closeFriends.manage')}
              variant="ghost"
              size="sm"
              icon="people-outline"
              onPress={() => router.push('/close-friends')}
              style={{ alignSelf: 'flex-start' }}
            />
            <Text style={{ color: c.ink, fontWeight: '600' }}>{t('m.create.expires')}</Text>
            <Segmented
              label={t('m.create.expires')}
              options={EXPIRES.map((e) => ({ id: e.id, label: t(e.label) }))}
              value={expiresIn}
              onChange={setExpiresIn}
            />
          </>
        ) : null}

        {kind === 'story' && closeFriends ? null : (
          <>
            <Text style={{ color: c.ink, fontWeight: '600' }}>{t('create.visibility')}</Text>
            <Segmented
              label={t('create.visibility')}
              options={VISIBILITY.filter((v) => v.id !== 'subscribers' || (hasPlans && kind !== 'story')).map((v) => ({ id: v.id, label: t(v.label) }))}
              value={visibility}
              onChange={setVisibility}
            />
          </>
        )}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {needsVerify || (me?.needsVerification && kind !== 'story' && visibility === 'public') ? <VerifyPrompt action="post" /> : null}
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
      {editing?.type === 'video' ? (
        <VideoEditor
          asset={editing}
          maxSeconds={me.plus ? PLUS_REEL_MAX_SECONDS : REEL_MAX_SECONDS}
          mustFit={kind === 'reel'}
          onCancel={() => setEditing(null)}
          onDone={(edits) => {
            setEditing(null);
            void upload(editing, edits);
          }}
        />
      ) : editing ? (
        <PhotoEditor
          asset={editing}
          onCancel={() => setEditing(null)}
          onDone={(p) => {
            setEditing(null);
            const edited =
              p.uri === editing.uri
                ? editing
                : { ...editing, uri: p.uri, width: p.width, height: p.height, mimeType: 'image/jpeg', fileName: 'photo.jpg', fileSize: undefined };
            void upload(edited, p.edits);
          }}
        />
      ) : null}
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
