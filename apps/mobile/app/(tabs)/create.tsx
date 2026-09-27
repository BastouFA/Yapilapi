import { useVideoPlayer, VideoView } from 'expo-video';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { onPendingAsset, takePendingAsset } from '../../lib/create-sheet';
import { useEffect, useRef, useState } from 'react';
import { Alert, Image, Linking, ScrollView, Text, View } from 'react-native';
import type { EditorParamsInput } from '../../../../packages/shared/src/filters';
import type { MessageKey } from '../../../../packages/shared/src/i18n';
import type { CaptionIdeas, Circle, MediaItem, PublicUser } from '../../../../packages/shared/src/types';
import { COMMENT_POLICIES, type CommentPolicy } from '../../../../packages/shared/src/constants';
import { useAutocomplete } from '../../lib/autocomplete';
import { Chips } from '../../lib/circles';
import { CoauthorPicker, PhotoTagger, type DraftTag } from '../../lib/collab';
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
import { formatBytes } from '../../../../packages/shared/src/data-saver';
import { listQueuedVideos, queuedAsAsset, queueVideo, removeQueuedVideo, useDataSaver, type QueuedVideo } from '../../lib/data-saver';
import { radius, space } from '../../lib/theme';
import { Button, Card, Field, Icon, KeyboardAvoid, Notice, Screen, Segmented, SwitchRow, useColors, userText, useTabBarSpace } from '../../lib/ui';
import { isVerificationError, VerifyPrompt } from '../../lib/safety';
import { StickerEditor, type DraftSticker } from '../../lib/story-stickers';
import { clipMax, draftMusic, MusicField, musicInput, soundAsTrack, type DraftMusic } from '../../lib/music';
import { SchedulePicker } from '../../lib/post-edit';
import { CaptionIdeasPanel, SuggestAltText } from '../../lib/ai-helpers';
import { useFlag } from '../../lib/flags';

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
/** 'circle' is offered for posts and reels once you have a circle; the post goes to the one chosen. */
type Visibility = (typeof VISIBILITY)[number]['id'] | 'circle';
type Attached = Uploaded & { local: string; seconds: number | null };
/** The reel a duet plays beside, or a remix takes its sound from. */
type Original = { id: string; username: string; media: MediaItem | null; soundTitle: string | null };

const kindFrom = (mode: string | undefined): Kind | null => (mode === 'reel' || mode === 'story' || mode === 'post' ? mode : null);

/**
 * Create: a text post, a reel (one video up to 3 minutes, optionally with a sound from the
 * sound page) or a story (optionally for close friends only), like the web composer. Posts
 * and reels can be saved as a draft or scheduled instead; Drafts opens one here to continue.
 */
export default function Create() {
  const c = useColors();
  const { t, number, dateTime } = useT();
  const { me } = useSession();
  const bottom = useTabBarSpace();
  const params = useLocalSearchParams<{ mode?: string; sound?: string; track?: string; draft?: string; remixOf?: string; remixMode?: string }>();
  const [kind, setKind] = useState<Kind>(kindFrom(params.mode) ?? 'post');
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<Visibility>(kind === 'story' ? 'friends' : 'public');
  const [expiresIn, setExpiresIn] = useState<(typeof EXPIRES)[number]['id']>('24h');
  const [media, setMedia] = useState<Attached | null>(null);
  // A description of the photo or video, for people using a screen reader.
  const [altText, setAltText] = useState('');
  // Caption ideas on screen, and whether one was used (the post is then marked as made with AI assistance).
  const [ideas, setIdeas] = useState<CaptionIdeas | null>(null);
  const [aiUsed, setAiUsed] = useState(false);
  const captionsOn = useFlag('AI_CAPTIONS');
  // The draft being continued, if any: saving, scheduling or publishing works on it.
  const [draftId, setDraftId] = useState<string | null>(null);
  // A draft's audience that the choices here don't cover (a circle or chosen people): kept unless another is picked.
  const [keptAudience, setKeptAudience] = useState<{ visibility: string; circleId: string | null; audience: string[] } | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [keeping, setKeeping] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [needsVerify, setNeedsVerify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [closeFriends, setCloseFriends] = useState(false);
  // Posts and reels: people invited to co-author (up to 3), and people tagged in the photo.
  const [coauthors, setCoauthors] = useState<PublicUser[]>([]);
  const [photoTags, setPhotoTags] = useState<DraftTag[]>([]);
  const ac = useAutocomplete(body, setBody);
  // Tags and the description belong to the photo they were written for (a draft brings its photo's along).
  const restoredTags = useRef<DraftTag[] | null>(null);
  const restoredAlt = useRef(false);
  useEffect(() => {
    setPhotoTags(restoredTags.current ?? []);
    restoredTags.current = null;
    if (!restoredAlt.current) setAltText('');
    restoredAlt.current = false;
  }, [media?.id]);
  // Stories: stickers placed on the preview, and whether people may add it to their own story.
  const [stickers, setStickers] = useState<DraftSticker[]>([]);
  const [allowReshare, setAllowReshare] = useState(true);
  // Music: a song or a sound, the part that plays (the whole sound on a reel) and, on stories, its sticker.
  const [music, setMusic] = useState<DraftMusic | null>(null);
  // Who can comment on the post or reel, and (reels) whether others may duet or remix it.
  const [commentPolicy, setCommentPolicy] = useState<CommentPolicy>('everyone');
  const [allowRemix, setAllowRemix] = useState(true);
  // A duet or remix of another reel ("Duet side by side" and "Remix with this sound" in Reels).
  const [remix, setRemix] = useState<{ id: string; mode: 'duet' | 'remix' } | null>(null);
  const [original, setOriginal] = useState<Original | null>(null);
  const [originalMissing, setOriginalMissing] = useState(false);
  // Posting for subscribers needs a subscription plan (set up in Studio on the web).
  const [hasPlans, setHasPlans] = useState(false);
  const [editing, setEditing] = useState<Picked | null>(null);
  const [applying, setApplying] = useState(false);
  // Data saver: a video picked on Data saver waits here, with what it costs to upload, until the
  // person chooses Upload now or Upload later on Wi-Fi. Videos saved for later are listed below.
  const saver = useDataSaver().active;
  const [confirmVideo, setConfirmVideo] = useState<Picked | null>(null);
  const [later, setLater] = useState<QueuedVideo[]>([]);
  const fromQueue = useRef<string | null>(null);
  useEffect(() => {
    void listQueuedVideos().then(setLater);
  }, []);
  const uploading = progress !== null;
  useEffect(() => {
    if (!me) return;
    void client()
      .then((api) => api.economy.plans(me.id))
      .then((r) => setHasPlans(r.items.length > 0))
      .catch(() => {});
  }, [me]);
  // Your circles, for sharing a post or reel with one of them. null until loaded.
  const [circles, setCircles] = useState<Circle[] | null>(null);
  const [circleId, setCircleId] = useState<string | null>(null);

  function switchTo(k: Kind) {
    setKind(k);
    setError(null);
    setNote(null);
    // Duets and remixes are reels.
    if (k !== 'reel') setRemix(null);
    // Keep only what the new kind can hold: a reel is a video.
    setMedia((m) => (k === 'reel' && m?.kind !== 'video' ? null : m));
    if (k === 'story' && (visibility === 'public' || visibility === 'subscribers' || visibility === 'circle')) setVisibility('friends');
    // The part keeps within what the new kind plays (15 seconds on stories).
    setMusic((m) => (m ? { ...m, durationMs: Math.min(m.durationMs, clipMax(m.track, k)) } : m));
  }

  // "Use this sound" on a sound page opens this tab as a reel with that sound; "Add to your story" as a story with it.
  useEffect(() => {
    if (!params.sound) return;
    const soundId = params.sound;
    const use = kindFrom(params.mode) ?? 'reel';
    router.setParams({ sound: '' });
    client()
      .then((api) => api.sounds.get(soundId))
      .then(
        (r) => setMusic(draftMusic(soundAsTrack(r.sound), use)),
        (e) => setError(errorMessage(e)),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.sound]);

  // "Use this song" on a song's page: in a post, reel or story.
  useEffect(() => {
    if (!params.track) return;
    const trackId = params.track;
    const use = kindFrom(params.mode) ?? 'post';
    router.setParams({ track: '' });
    client()
      .then((api) => api.music.track(trackId))
      .then(
        (r) => setMusic(draftMusic(r.track, use)),
        (e) => setError(errorMessage(e)),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.track]);

  // "Duet side by side" or "Remix with this sound" on a reel opens this tab as a reel made from it.
  useEffect(() => {
    if (!params.remixOf) return;
    const id = params.remixOf;
    const mode = params.remixMode === 'remix' ? 'remix' : 'duet';
    router.setParams({ remixOf: '', remixMode: '' });
    setKind('reel');
    setMedia((m) => (m?.kind === 'video' ? m : null));
    setMusic(null);
    setRemix({ id, mode });
    setOriginal(null);
    setOriginalMissing(false);
    client()
      .then((api) => api.posts.get(id))
      .then(
        (r) =>
          r.post.format === 'reel'
            ? setOriginal({
                id: r.post.id,
                username: r.post.author.username,
                media: r.post.media.find((m) => m.kind === 'video') ?? null,
                soundTitle: r.post.sound?.title ?? null,
              })
            : setOriginalMissing(true),
        () => setOriginalMissing(true),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.remixOf]);

  // Drafts ("Continue") opens a draft here.
  useEffect(() => {
    if (!params.draft) return;
    const id = params.draft;
    router.setParams({ draft: '' });
    client()
      .then((api) => api.drafts.get(id))
      .then(
        ({ post, circleId, audience }) => {
          setDraftId(id);
          setKind(post.format === 'reel' ? 'reel' : 'post');
          setBody(post.body);
          setAiUsed(!!post.aiAssisted);
          if (VISIBILITY.some((v) => v.id === post.visibility) || (post.visibility === 'circle' && circleId)) {
            setVisibility(post.visibility as Visibility);
            if (circleId) setCircleId(circleId);
            setKeptAudience(null);
          } else setKeptAudience({ visibility: post.visibility, circleId, audience });
          const m = post.media[0];
          restoredTags.current = (m?.tags ?? []).map((x) => ({ user: x.user, x: x.x, y: x.y }));
          restoredAlt.current = true;
          setAltText(m?.altText ?? '');
          setMedia(m ? { id: m.id, kind: m.kind, url: m.url, local: mediaUrl(m.variants?.medium ?? m.url), seconds: null } : null);
          setCoauthors(post.pendingCollaborators ?? []);
          setCommentPolicy(post.commentPolicy ?? 'everyone');
          setAllowRemix(post.allowRemix ?? true);
          const from = post.remixOf?.post;
          setRemix(post.format === 'reel' && post.remixOf && from ? { id: from.id, mode: post.remixOf.mode } : null);
          setOriginal(from ? { id: from.id, username: from.author.username, media: from.media, soundTitle: null } : null);
          setOriginalMissing(post.format === 'reel' && !!post.remixOf && !from);
          // Music on the draft: the song or sound, with the part it plays.
          const use = post.format === 'reel' ? 'reel' : 'post';
          const part = post.music ? { startMs: post.music.startMs, durationMs: post.music.durationMs } : undefined;
          setMusic(null);
          if (post.music?.source === 'library')
            void client()
              .then((api) => api.sounds.get(post.music!.id))
              .then((r) => setMusic(draftMusic(soundAsTrack(r.sound), use, part)))
              .catch(() => {});
          else if (post.music)
            void client()
              .then((api) => api.music.track(post.music!.id))
              .then((r) => setMusic(draftMusic(r.track, use, part)))
              .catch(() => {});
          else if (post.format === 'reel' && post.sound && !post.sound.original)
            void client()
              .then((api) => api.sounds.get(post.sound!.id))
              .then((r) => setMusic(draftMusic(soundAsTrack(r.sound), 'reel')))
              .catch(() => {});
          setError(null);
          setNote(null);
        },
        (e) => setError(errorMessage(e)),
      );
  }, [params.draft]);

  // Home ("Your story") and Reels ("Make a reel") open this tab in a given mode.
  useEffect(() => {
    const k = kindFrom(params.mode);
    if (!k) return;
    switchTo(k);
    // Clear it, so the same link works again after switching modes by hand.
    router.setParams({ mode: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.mode]);

  // Taken or picked in the camera screen ("+", the story strip, or a double tap on a mode), possibly for another kind.
  // It is taken once this tab is showing and the camera has slid away: the editor is a modal, and
  // iOS can't present one while the camera is still being dismissed.
  const focused = useIsFocused();
  // Loaded each time this tab shows, so a circle made (or deleted) meanwhile is there.
  useEffect(() => {
    if (!me || !focused) return;
    void client()
      .then((api) => api.circles.list())
      .then((r) => {
        setCircles(r.items);
        setCircleId((cur) => (cur && r.items.some((x) => x.id === cur) ? cur : null));
        if (!r.items.length) setVisibility((v) => (v === 'circle' ? 'public' : v));
      })
      .catch(() => setCircles((cur) => cur ?? []));
  }, [me, focused]);
  const [incoming, setIncoming] = useState<ReturnType<typeof takePendingAsset>>(null);
  useEffect(() => {
    if (!focused) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const take = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const p = takePendingAsset();
        if (p) setIncoming(p);
      }, 500);
    };
    take();
    const off = onPendingAsset(take);
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [focused]);
  useEffect(() => {
    if (!incoming) return;
    if (incoming.mode !== kind) {
      setKind(incoming.mode);
      return;
    }
    setIncoming(null);
    setError(null);
    handlePicked(incoming.asset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming, kind]);

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
    handlePicked(asset);
  }

  /** A photo or video from the library, the camera or the "+" button: check it, then edit or upload it. */
  function handlePicked(asset: Picked, o: { confirmed?: boolean } = {}) {
    const check = validate(asset);
    if (check) {
      fromQueue.current = null;
      return setError(check);
    }
    // On Data saver, say what a video costs to upload and offer to keep it for Wi-Fi.
    if (saver && asset.type === 'video' && !o.confirmed) return setConfirmVideo(asset);
    // Photos (not GIFs) and videos open in the editor first.
    if (asset.type === 'video' || (asset.type === 'image' && asset.mimeType !== 'image/gif')) setEditing(asset);
    else void upload(asset, null);
  }

  /** Upload the picked (or edited) file, then have the server apply the look, trim and the rest. */
  async function upload(asset: Picked, edits: EditorParamsInput | null) {
    setProgress(0);
    try {
      const m = await uploadPicked(asset, setProgress);
      // A video saved for Wi-Fi is done once it is uploaded.
      if (fromQueue.current) {
        await removeQueuedVideo(fromQueue.current);
        fromQueue.current = null;
        setLater(await listQueuedVideos());
      }
      const seconds = asset.duration ? asset.duration / 1000 : null;
      if (!edits) return setMedia({ ...m, local: asset.uri, seconds });
      setApplying(true);
      const api = await client();
      const started = await api.media.edit(m.id, edits);
      const done = await api.media.waitUntilReady(started.media.id);
      const url = done.kind === 'video' ? (done.variants.mp4 ?? done.url) : (done.variants.large ?? done.variants.medium ?? done.url);
      setMedia({ id: done.id, kind: m.kind, url, local: mediaUrl(url), seconds: done.durationMs ? done.durationMs / 1000 : seconds });
    } catch (e) {
      // A video saved for Wi-Fi that failed to upload stays saved.
      fromQueue.current = null;
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

  // Music goes on photo and text posts (not videos).
  const postCanHaveMusic = !media || media.kind === 'image';

  /** What the post or reel says and shows. */
  function content(): Record<string, unknown> {
    const audience = keptAudience
      ? {
          visibility: keptAudience.visibility,
          circleId: keptAudience.circleId ?? undefined,
          audience: keptAudience.audience.length ? keptAudience.audience : undefined,
        }
      : { visibility, ...(visibility === 'circle' && circleId ? { circleId } : {}) };
    const described = altText.trim() ? { altText: altText.trim() } : {};
    const assisted = aiUsed ? { aiAssisted: true } : {};
    if (kind === 'reel') {
      const v = media!;
      return {
        format: 'reel',
        body,
        ...assisted,
        ...audience,
        media: [{ id: v.id, url: mediaUrl(v.url), kind: 'video', ...described }],
        allowRemix,
        commentPolicy,
        // A duet or remix uses the original; otherwise a sound plays in full instead of the video's own, and a song plays the chosen part.
        ...(remix && original
          ? { remixOf: remix.id, remixMode: remix.mode }
          : music?.track.source === 'library'
            ? { soundId: music.track.id }
            : music
              ? { music: { trackId: music.track.id, startMs: music.startMs, durationMs: music.durationMs } }
              : {}),
        ...(coauthors.length ? { collaborators: coauthors.map((u) => u.id) } : {}),
      };
    }
    return {
      body,
      ...assisted,
      ...audience,
      ...(media
        ? {
            media: [
              {
                id: media.id,
                url: mediaUrl(media.url),
                kind: media.kind,
                ...described,
                ...(media.kind === 'image' && photoTags.length ? { tags: photoTags.map((x) => ({ userId: x.user.id, x: x.x, y: x.y })) } : {}),
              },
            ],
          }
        : {}),
      ...(coauthors.length ? { collaborators: coauthors.map((u) => u.id) } : {}),
      commentPolicy,
      ...(music && postCanHaveMusic
        ? {
            music: {
              ...(music.track.source === 'library' ? { soundId: music.track.id } : { trackId: music.track.id }),
              startMs: music.startMs,
              durationMs: music.durationMs,
            },
          }
        : {}),
    };
  }

  function clear() {
    setBody('');
    setIdeas(null);
    setAiUsed(false);
    setCoauthors([]);
    setMedia(null);
    setMusic(null);
    setAltText('');
    setDraftId(null);
    setKeptAudience(null);
    setCommentPolicy('everyone');
    setAllowRemix(true);
    setRemix(null);
    setOriginal(null);
    setOriginalMissing(false);
  }

  /** Keep it for later: a draft, or scheduled for `at`. */
  async function keep(at: Date | null) {
    setScheduling(false);
    setKeeping(true);
    setError(null);
    setNote(null);
    setNeedsVerify(false);
    try {
      const api = await client();
      if (draftId) await api.drafts.save(draftId, { ...content(), ...(at ? { scheduledAt: at.toISOString() } : {}) });
      else await api.posts.create({ ...content(), ...(at ? { scheduledAt: at.toISOString() } : { draft: true }) });
      clear();
      Alert.alert(at ? t('m.create.scheduled', { time: dateTime(at) }) : t('m.create.draftSaved'));
      router.push('/drafts');
    } catch (e) {
      if (isVerificationError(e)) setNeedsVerify(true);
      else setError(errorMessage(e));
    } finally {
      setKeeping(false);
    }
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
          visibility: closeFriends ? 'close_friends' : visibility === 'subscribers' || visibility === 'circle' ? 'friends' : visibility,
          allowReshare,
          stickers: stickers.map(({ key: _key, label: _label, ...s }) => s),
          music: music ? musicInput(music) : undefined,
        });
        setBody('');
        setMedia(null);
        setStickers([]);
        setMusic(null);
        Alert.alert(t('m.create.storyShared'));
        router.navigate('/');
        return;
      }
      // A draft is saved with what's here now, then published through the same checks as a new post.
      const r = draftId ? (await api.drafts.save(draftId, content()), await api.drafts.publish(draftId)) : await api.posts.create(content());
      clear();
      if (kind === 'reel') {
        if (r.moderation) Alert.alert(r.moderation.message);
        router.push({ pathname: '/reels', params: { start: r.post.id } });
        return;
      }
      if (r.moderation) setNote(r.moderation.message);
      // Home shows the new post at the top, whatever the feed's ranking.
      else router.navigate({ pathname: '/', params: { posted: r.post.id } });
    } catch (e) {
      if (isVerificationError(e)) setNeedsVerify(true);
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const hint = KINDS.find((k) => k.id === kind)!.hint;
  const forCircle = kind !== 'story' && !keptAudience && visibility === 'circle';
  const chosenCircle = circles?.find((x) => x.id === circleId) ?? null;
  const canPublish =
    !busy &&
    !keeping &&
    !uploading &&
    (!forCircle || !!chosenCircle) &&
    (kind !== 'reel' || !remix || !!original) &&
    (kind === 'reel' ? media?.kind === 'video' : !!body.trim() || !!media || (kind === 'story' && (stickers.length > 0 || !!music)));
  const audienceOptions: { id: Visibility; label: string }[] = [
    ...VISIBILITY.filter((v) => v.id !== 'subscribers' || (hasPlans && kind !== 'story')).map((v) => ({ id: v.id, label: t(v.label) })),
    ...(kind !== 'story' && circles?.length
      ? [{ id: 'circle' as const, label: forCircle && chosenCircle ? t('m.create.circle', { name: chosenCircle.name }) : t('visibility.circle') }]
      : []),
    // A draft's audience the choices here don't cover (chosen people): kept unless another is picked.
    ...(keptAudience && kind !== 'story'
      ? [{ id: keptAudience.visibility as Visibility, label: t(`visibility.${keptAudience.visibility}` as MessageKey) }]
      : []),
  ];

  return (
    <KeyboardAvoid>
      <ScrollView
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: bottom }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[2] }}>
          {draftId ? (
            <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800', flexShrink: 1 }}>
              {t('m.create.continueDraft')}
            </Text>
          ) : (
            <View />
          )}
          <Button label={t('m.create.drafts')} icon="document-text-outline" variant="ghost" size="sm" onPress={() => router.push('/drafts')} />
        </View>
        <Segmented
          label={t('m.create.mode')}
          options={KINDS.map((k) => ({ id: k.id, label: t(k.label) }))}
          value={kind}
          onChange={switchTo}
          // A quick double tap on Post, Reel or Story opens the camera in that mode.
          onDoublePress={(k) => router.push({ pathname: '/camera', params: { mode: k } })}
          doublePressLabel={t('m.create.openCamera')}
        />
        <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>{t(hint)}</Text>
        {kind === 'reel' && remix ? (
          <RemixSource
            mode={remix.mode}
            original={original}
            missing={originalMissing}
            onCancel={() => {
              setRemix(null);
              setOriginal(null);
              setOriginalMissing(false);
            }}
          />
        ) : null}
        <Card style={{ gap: space[3] }}>
          <Field
            label={kind === 'reel' ? t('m.create.reel.caption') : kind === 'story' ? t('m.create.story.body') : t('create.placeholder')}
            {...ac.inputProps}
            multiline
            maxLength={kind === 'story' ? 500 : kind === 'reel' ? 2200 : 5000}
            style={{ minHeight: kind === 'post' ? 140 : 96, textAlignVertical: 'top', paddingTop: 12 }}
          />
          {ac.list}
          {captionsOn && kind !== 'story' ? (
            <Button
              label={t('create.aiCaption')}
              icon="sparkles-outline"
              size="sm"
              variant="ghost"
              disabled={!body.trim() && media?.kind !== 'image'}
              style={{ alignSelf: 'flex-start' }}
              onPress={async () => {
                setError(null);
                try {
                  const r = await (
                    await client()
                  ).ai.captions({ text: body, mediaIds: media?.kind === 'image' ? [media.id] : [], format: kind === 'reel' ? 'reel' : 'post' });
                  setIdeas(r.ideas);
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            />
          ) : null}
          {ideas ? (
            <CaptionIdeasPanel
              ideas={ideas}
              onUse={(caption) => {
                // Keep the hashtags already written; the idea replaces the rest.
                const tags = body.match(/(^|\s)#[\p{L}\p{M}\p{N}_]+/gu)?.join('') ?? '';
                setBody(`${caption}${tags}`.slice(0, 5000));
                setAiUsed(true);
              }}
              onAddTag={(tag) => setBody((b) => `${b.trimEnd()} #${tag}`.trimStart())}
              onClose={() => setIdeas(null)}
            />
          ) : null}

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
              onPress={() => choose()}
              style={{ alignSelf: 'flex-start' }}
            />
            {confirmVideo ? (
              <Notice tone="warn" title={t('dataSaver.title')}>
                <Text style={{ color: c.ink, lineHeight: 20 }}>
                  {confirmVideo.fileSize ? `${t('dataSaver.videoSize', { size: formatBytes(confirmVideo.fileSize) })} ` : ''}
                  {t('dataSaver.videoWifi')}
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
                  <Button
                    label={t('dataSaver.uploadNow')}
                    size="sm"
                    onPress={() => {
                      const a = confirmVideo;
                      setConfirmVideo(null);
                      handlePicked(a, { confirmed: true });
                    }}
                  />
                  <Button
                    label={t('dataSaver.uploadLater')}
                    size="sm"
                    variant="secondary"
                    onPress={async () => {
                      const a = confirmVideo;
                      setConfirmVideo(null);
                      try {
                        await queueVideo(a);
                        setLater(await listQueuedVideos());
                        setNote(t('dataSaver.queued'));
                      } catch (e) {
                        setError(errorMessage(e));
                      }
                    }}
                  />
                </View>
              </Notice>
            ) : null}
            {later.length ? (
              <View style={{ gap: space[2] }}>
                <Text style={{ color: c.ink, fontWeight: '700', fontSize: 14 }}>{t('dataSaver.queueTitle')}</Text>
                <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('dataSaver.queueHint')}</Text>
                {later.map((q) => (
                  <View key={q.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
                    <Icon name="videocam-outline" size={18} color={c.inkMuted} />
                    <Text style={{ color: c.ink, flex: 1, fontSize: 14 }} numberOfLines={1}>
                      {[q.duration ? clock(q.duration / 1000) : null, q.fileSize ? formatBytes(q.fileSize) : null].filter(Boolean).join(' · ') || q.fileName}
                    </Text>
                    <Button
                      label={t('dataSaver.uploadNow')}
                      size="sm"
                      variant="secondary"
                      disabled={uploading || busy}
                      onPress={() => {
                        fromQueue.current = q.id;
                        handlePicked(queuedAsAsset(q), { confirmed: true });
                      }}
                    />
                    <Button
                      label={t('dataSaver.remove')}
                      size="sm"
                      variant="ghost"
                      onPress={async () => {
                        await removeQueuedVideo(q.id);
                        setLater(await listQueuedVideos());
                      }}
                    />
                  </View>
                ))}
              </View>
            ) : null}
            {denied ? (
              <Notice tone="warn">
                <Text style={{ color: c.ink, lineHeight: 20 }}>{t('m.create.photosPermission')}</Text>
                <Button
                  label={t('m.common.openSettings')}
                  size="sm"
                  variant="secondary"
                  onPress={() => Linking.openSettings()}
                  style={{ alignSelf: 'flex-start' }}
                />
              </Notice>
            ) : null}
          </View>

          {media && media.kind !== 'audio' && kind !== 'story' ? (
            <>
              <Field label={t('m.create.altText')} placeholder={t('m.create.altTextPlaceholder')} value={altText} onChangeText={setAltText} maxLength={500} />
              {media.kind === 'image' ? <SuggestAltText mediaId={media.id} onSuggested={setAltText} onError={setError} /> : null}
            </>
          ) : null}
          {kind === 'post' && media?.kind === 'image' ? <PhotoTagger uri={media.local} value={photoTags} onChange={setPhotoTags} /> : null}
          {kind !== 'story' ? <CoauthorPicker value={coauthors} onChange={setCoauthors} /> : null}

          {kind === 'reel' && !remix ? <MusicField use="reel" value={music} onChange={setMusic} /> : null}
          {kind === 'post' && postCanHaveMusic ? <MusicField use="post" value={music} onChange={setMusic} /> : null}

          {kind === 'story' ? (
            <>
              {media?.kind !== 'audio' ? <MusicField use="story" value={music} onChange={setMusic} video={media?.kind === 'video'} /> : null}
              <StickerEditor
                stickers={stickers}
                onChange={setStickers}
                preview={{ uri: media?.local, kind: media?.kind, body }}
                music={music ? { label: `${music.track.title} · ${music.track.artist}`, x: music.x, y: music.y } : null}
                onMoveMusic={(x, y) => setMusic((m) => (m ? { ...m, x, y } : m))}
              />
              <SwitchRow label={t('m.stories.allowReshare')} hint={t('m.stories.allowReshareHint')} value={allowReshare} onValueChange={setAllowReshare} />
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
              <Chips
                label={t('create.visibility')}
                options={audienceOptions}
                value={keptAudience && kind !== 'story' ? (keptAudience.visibility as Visibility) : visibility}
                onChange={(v) => {
                  if (!v) return;
                  if (keptAudience && v === keptAudience.visibility) return;
                  setKeptAudience(null);
                  setVisibility(v);
                  // With a single circle there is nothing to choose.
                  if (v === 'circle' && !circleId && circles?.length === 1) setCircleId(circles[0]!.id);
                }}
              />
              {forCircle && circles?.length ? (
                <View style={{ gap: space[2] }}>
                  <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.create.chooseCircle')}</Text>
                  <Chips
                    label={t('m.create.chooseCircle')}
                    options={circles.map((x) => ({ id: x.id, label: x.name, icon: 'ellipse-outline' as const }))}
                    value={circleId}
                    onChange={setCircleId}
                  />
                  <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.create.circleHint')}</Text>
                  <Button
                    label={t('m.create.editCircles')}
                    variant="ghost"
                    size="sm"
                    icon="people-outline"
                    onPress={() => router.push('/circles')}
                    style={{ alignSelf: 'flex-start' }}
                  />
                </View>
              ) : null}
              {kind !== 'story' && circles && !circles.length ? (
                <Button
                  label={t('m.create.makeCircle')}
                  variant="ghost"
                  size="sm"
                  icon="add-circle-outline"
                  onPress={() => router.push('/circles')}
                  style={{ alignSelf: 'flex-start' }}
                />
              ) : null}
            </>
          )}
          {kind !== 'story' ? (
            <View style={{ gap: space[2] }}>
              <Text style={{ color: c.ink, fontWeight: '600' }}>{t('comments.settings.title')}</Text>
              <Chips
                label={t('comments.settings.title')}
                options={COMMENT_POLICIES.map((p) => ({ id: p, label: t(`comments.policy.${p}`) }))}
                value={commentPolicy}
                onChange={(p) => p && setCommentPolicy(p)}
              />
            </View>
          ) : null}
          {kind === 'reel' ? (
            <SwitchRow label={t('compose.allowRemix')} hint={t('compose.allowRemixHint')} value={allowRemix} onValueChange={setAllowRemix} />
          ) : null}
          {error ? <Notice tone="danger">{error}</Notice> : null}
          {needsVerify || (me?.needsVerification && kind !== 'story' && visibility === 'public') ? <VerifyPrompt action="post" /> : null}
          {note ? <Notice>{note}</Notice> : null}
          <Button
            label={
              busy
                ? t('m.create.publishing')
                : kind === 'story'
                  ? t('m.create.shareStory')
                  : kind === 'reel'
                    ? remix
                      ? t(remix.mode === 'duet' ? 'compose.publishDuet' : 'compose.publishRemix')
                      : t('m.create.publishReel')
                    : t('create.publish')
            }
            disabled={!canPublish}
            onPress={() => publish()}
          />
          {kind !== 'story' ? (
            <View style={{ flexDirection: 'row', gap: space[2] }}>
              <Button label={t('m.create.saveDraft')} variant="secondary" size="sm" disabled={!canPublish} onPress={() => keep(null)} style={{ flex: 1 }} />
              <Button
                label={t('m.create.schedule')}
                icon="calendar-outline"
                variant="secondary"
                size="sm"
                disabled={!canPublish}
                onPress={() => setScheduling(true)}
                style={{ flex: 1 }}
              />
            </View>
          ) : null}
        </Card>
        <SchedulePicker visible={scheduling} onClose={() => setScheduling(false)} onPick={(at) => void keep(at)} />
        {kind === 'post' ? <Button label={t('m.real.capture')} icon="camera-outline" variant="secondary" onPress={() => router.push('/real')} /> : null}
        {editing?.type === 'video' ? (
          <VideoEditor
            asset={editing}
            maxSeconds={me.plus ? PLUS_REEL_MAX_SECONDS : REEL_MAX_SECONDS}
            mustFit={kind === 'reel'}
            onCancel={() => {
              fromQueue.current = null;
              setEditing(null);
            }}
            onDone={(edits) => {
              setEditing(null);
              void upload(editing, edits);
            }}
          />
        ) : editing ? (
          <PhotoEditor
            asset={editing}
            onCancel={() => {
              fromQueue.current = null;
              setEditing(null);
            }}
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
    </KeyboardAvoid>
  );
}

/** The reel a duet plays beside (on the left), or whose sound a remix uses. */
function RemixSource({ mode, original, missing, onCancel }: { mode: 'duet' | 'remix'; original: Original | null; missing: boolean; onCancel: () => void }) {
  const c = useColors();
  const { t } = useT();
  if (missing)
    return (
      <Notice tone="danger">
        <Text style={{ color: c.ink, lineHeight: 20 }}>{t(mode === 'duet' ? 'compose.duetUnavailable' : 'compose.remixUnavailable')}</Text>
        <Button label={t('m.common.remove')} variant="secondary" size="sm" icon="close" onPress={onCancel} style={{ alignSelf: 'flex-start' }} />
      </Notice>
    );
  if (!original) return <Text style={{ color: c.inkMuted, fontSize: 14 }}>{t('compose.loadingOriginal')}</Text>;
  const poster = original.media ? (original.media.variants?.thumb ?? original.media.posterUrl) : null;
  return (
    <Card style={{ flexDirection: 'row', gap: space[3], alignItems: 'center' }}>
      <View style={{ width: 60, height: 96, borderRadius: radius.md, overflow: 'hidden', backgroundColor: '#0B0C14' }}>
        {poster ? (
          <Image source={{ uri: mediaUrl(poster) }} style={{ width: '100%', height: '100%' }} resizeMode="cover" accessibilityIgnoresInvertColors />
        ) : null}
      </View>
      <View style={{ flex: 1, gap: space[1] }}>
        <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
          {t(mode === 'duet' ? 'm.reels.duetWith' : 'm.reels.remixOf', { name: original.username })}
        </Text>
        <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t(mode === 'duet' ? 'compose.duetHint' : 'compose.remixHint')}</Text>
        {original.soundTitle ? (
          <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
            {t('m.create.sound', { title: original.soundTitle })}
          </Text>
        ) : null}
        <Button label={t('m.common.remove')} variant="ghost" size="sm" icon="close" onPress={onCancel} style={{ alignSelf: 'flex-start' }} />
      </View>
    </Card>
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
