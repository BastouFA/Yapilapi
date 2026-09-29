'use client';

import {
  noticeText,
  COLLAGE_MAX_PHOTOS,
  COLLAGE_MIN_PHOTOS,
  COMMENT_POLICIES,
  extractHashtags,
  formatBytes,
  isVideoFile,
  MEDIA_ACCEPT,
  VIDEO_ACCEPT,
  type CaptionIdeas,
  type CollageShape,
  type CommentPolicy,
} from '@yapilapi/shared';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AutocompleteText } from '@/components/Autocomplete';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Alert, BottomSheet, Button, Checkbox, formatScheduled, Segments, Select, TextField } from '@yapilapi/design-system';
import {
  ECHO_PERMISSIONS,
  type EchoPermission,
  MAX_COLLABORATORS,
  POST_VISIBILITIES,
  SCHEDULE_MAX_DAYS,
  SCHEDULE_MIN_MINUTES,
  STORY_VISIBILITIES,
  VISIBILITIES,
  type Community,
  type MessageKey,
  type Post,
  type PublicUser,
  type StoryVisibility,
  type Visibility,
  type EditorParamsInput,
} from '@yapilapi/shared';

/** Posts can be for subscribers, stories for close friends; one picker holds either. */
type Audience = Visibility | StoryVisibility;
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { isVerificationError, VerifyPrompt } from '@/components/Verification';
import { SimilarQuestions } from '@/components/CommunityExtras';
import { CaptionIdeasPanel, SuggestAltText } from '@/components/AiHelpers';
import type { CollagePhoto } from '@/components/Collage';
import { EditorLoading } from '@/components/Loading';
import { onPendingMedia, takePendingMedia } from '@/lib/pending-media';
import { PeoplePicker } from '@/components/PeoplePicker';
import { PhotoTagger, type DraftTag } from '@/components/PhotoTags';
import { StoryStickerEditor, type DraftSticker } from '@/components/StoryStickerEditor';
import { clipMax, draftMusic, MusicField, musicInput, soundAsTrack, type DraftMusic } from '@/components/MusicPicker';
import { localInput, nextHour, scheduleBounds } from '@/lib/schedule';
import { useSession } from '../../providers';

// The editors open full screen once photos or a video are picked, so they download then.
const PhotoEditor = dynamic(() => import('@/components/editor/PhotoEditor').then((m) => m.PhotoEditor), { ssr: false, loading: () => <EditorLoading /> });
const VideoEditor = dynamic(() => import('@/components/editor/VideoEditor').then((m) => m.VideoEditor), { ssr: false, loading: () => <EditorLoading /> });
const CollageEditor = dynamic(() => import('@/components/Collage').then((m) => m.CollageEditor), { ssr: false, loading: () => <EditorLoading /> });

type Uploaded = { id: string; kind: 'image' | 'video' | 'audio'; url: string; altText: string; tags: DraftTag[] };

/** Reels: 3 minutes, or 10 minutes with YAPILAPI Plus (the API enforces the same limits). */
const REEL_MAX_SECONDS = 180;
const PLUS_REEL_MAX_SECONDS = 600;

/** What Create makes, in the order of the buttons at the top. */
const KINDS = ['post', 'reel', 'story'] as const;

/** Photos and videos that open in the editor before uploading (GIFs keep their animation, so they skip it). */
const EDITABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm']);

/** A video file's length, read in the browser before uploading. */
function videoSeconds(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(v.duration) ? v.duration : 0);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
    v.src = url;
  });
}

function Create() {
  const { t, tp, toast, me, dataSaver, locale, flags } = useSession();
  // Data saver: what the videos just picked will cost to upload (photos are made smaller on their own).
  const [videoCost, setVideoCost] = useState<number | null>(null);
  const reelMax = me?.plus ? PLUS_REEL_MAX_SECONDS : REEL_MAX_SECONDS;
  const router = useRouter();
  const params = useSearchParams();
  // Duet, remix or "Use this sound" links open Create as a reel, prefilled; "Add to your story" on a sound opens a story with it.
  const remixOf = params.get('remixOf');
  const remixMode = params.get('remixMode') === 'remix' ? 'remix' : 'duet';
  const initialMode =
    params.get('mode') === 'story' && !remixOf
      ? 'story'
      : params.get('mode') === 'reel' || remixOf || (params.get('sound') && params.get('mode') !== 'post')
        ? 'reel'
        : params.get('moment')
          ? 'story'
          : 'post';
  const [kind, setKind] = useState<'post' | 'reel' | 'story'>(initialMode);
  const [body, setBody] = useState(() => (params.get('text') ?? '').slice(0, 5000));
  const [visibility, setVisibility] = useState<Audience>(initialMode === 'story' ? 'friends' : 'public');
  const [original, setOriginal] = useState<Post | null>(null);
  const [originalMissing, setOriginalMissing] = useState(false);
  const [soundTitle, setSoundTitle] = useState('');
  const [allowRemix, setAllowRemix] = useState(true);
  // Who may echo the reel; '' keeps the default for the account (everyone, or nobody for private and under-18 accounts).
  const [allowEchoes, setAllowEchoes] = useState<EchoPermission | ''>('');
  const [commentPolicy, setCommentPolicy] = useState<CommentPolicy>('everyone');
  const [communityId, setCommunityId] = useState(params.get('community') ?? '');
  const [communities, setCommunities] = useState<Community[]>([]);
  const [circles, setCircles] = useState<{ id: string; name: string }[]>([]);
  const [circleId, setCircleId] = useState('');
  // Posting for subscribers needs a subscription plan (set up in Studio).
  const [hasPlans, setHasPlans] = useState(false);
  const [media, setMedia] = useState<Uploaded[]>([]);
  // The photo whose tags are open for editing.
  const [taggingId, setTaggingId] = useState<string | null>(null);
  const tagging = media.find((m) => m.id === taggingId && m.kind === 'image') ?? null;
  // People invited to co-author (people you follow who follow you back).
  const [collaborators, setCollaborators] = useState<PublicUser[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [poll, setPoll] = useState<string[] | null>(null);
  const [topics, setTopics] = useState('');
  const [expiresIn, setExpiresIn] = useState<'1h' | '24h' | 'permanent' | 'custom'>('24h');
  // With a chosen length: how many hours the story stays up (1 to 720), as typed.
  const [customHours, setCustomHours] = useState('48');
  // Stories: stickers placed on the preview, and whether people may add it to their own story.
  const [stickers, setStickers] = useState<DraftSticker[]>([]);
  const [allowReshare, setAllowReshare] = useState(true);
  // Music: a song or a sound, the part that plays (the whole sound on a reel) and, on stories, its sticker.
  const [music, setMusic] = useState<DraftMusic | null>(null);
  const [ai, setAi] = useState<CaptionIdeas | null>(null);
  const [aiUsed, setAiUsed] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsVerify, setNeedsVerify] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'publish' | 'draft' | 'schedule' | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // The collage editor, with the photos going into it; stories pick theirs with their own file input.
  const [collage, setCollage] = useState<{ photos: CollagePhoto[]; shape: CollageShape } | null>(null);
  const collageRef = useRef<HTMLInputElement>(null);
  // A draft opened from Drafts: saving, scheduling or publishing works on it instead of starting a new post.
  const draftId = params.get('draft');
  const [draftLoaded, setDraftLoaded] = useState(!draftId);
  // People a draft was for, when it was for chosen people (kept as they are; there's no picker for them here).
  const [audience, setAudience] = useState<string[]>([]);
  const [scheduling, setScheduling] = useState(false);
  const [when, setWhen] = useState(nextHour);

  useEffect(() => {
    if (!draftId) return;
    api.drafts.get(draftId).then(
      ({ post, circleId: circle, audience: people }) => {
        setKind(post.format === 'reel' ? 'reel' : 'post');
        setBody(post.body);
        setVisibility(post.visibility);
        setCommunityId(post.community?.id ?? '');
        setCircleId(circle ?? '');
        setAudience(people);
        setMedia(
          post.media.map((m) => ({
            id: m.id,
            kind: m.kind,
            url: m.url,
            altText: m.altText ?? '',
            tags: (m.tags ?? []).map((tag) => ({ user: tag.user, x: tag.x, y: tag.y })),
          })),
        );
        setCollaborators(post.pendingCollaborators ?? []);
        setPoll(post.poll ? post.poll.options.map((o) => o.label) : null);
        // Topics that aren't #tags in the text were chosen by hand.
        const inText = extractHashtags(post.body, 50);
        setTopics(post.topics.filter((tp) => !inText.includes(tp)).join(', '));
        if (post.allowRemix !== undefined) setAllowRemix(post.allowRemix);
        if (post.allowEchoes) setAllowEchoes(post.allowEchoes);
        if (post.commentPolicy) setCommentPolicy(post.commentPolicy);
        if (post.sound?.original) setSoundTitle(post.sound.title);
        // Music on the draft: the song or sound as the picker has it, with the part it plays.
        const use = post.format === 'reel' ? 'reel' : 'post';
        const part = post.music ? { startMs: post.music.startMs, durationMs: post.music.durationMs } : undefined;
        if (post.music?.source === 'library')
          api.sounds.get(post.music.id).then(
            (r) => setMusic(draftMusic(soundAsTrack(r.sound), use, part)),
            () => {},
          );
        else if (post.music)
          api.music.track(post.music.id).then(
            (r) => setMusic(draftMusic(r.track, use, part)),
            () => {},
          );
        else if (post.format === 'reel' && post.sound && !post.sound.original)
          api.sounds.get(post.sound.id).then(
            (r) => setMusic(draftMusic(soundAsTrack(r.sound), 'reel')),
            () => {},
          );
        setAiUsed(post.aiAssisted);
        if (post.scheduledAt) setWhen(localInput(new Date(post.scheduledAt)));
        setDraftLoaded(true);
      },
      (e) => {
        toast(errorMessage(e));
        router.replace('/drafts');
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId]);

  useEffect(() => {
    if (remixOf)
      api.posts.get(remixOf).then(
        (r) => (r.post.format === 'reel' ? setOriginal(r.post) : setOriginalMissing(true)),
        () => setOriginalMissing(true),
      );
    // "Use this sound" and "Use this song" links.
    const soundId = params.get('sound');
    if (soundId && !remixOf)
      api.sounds.get(soundId).then(
        (r) => setMusic(draftMusic(soundAsTrack(r.sound), initialMode)),
        () => toast(t('m.sound.missing')),
      );
    const trackId = params.get('track');
    if (trackId && !remixOf)
      api.music.track(trackId).then(
        (r) => setMusic(draftMusic(r.track, initialMode)),
        () => toast(t('music.track.missing')),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remixOf]);

  useEffect(() => {
    api.communities
      .list('mine')
      .then((r) => setCommunities(r.items))
      .catch(() => {});
    api.me
      .circles()
      .then((r) => setCircles(r.items))
      .catch(() => {});
    if (me)
      api.economy
        .plans(me.id)
        .then((r) => setHasPlans(r.items.length > 0))
        .catch(() => {});
  }, [me]);

  // Files waiting for the editor, one at a time, and uploads running one after another.
  const [queue, setQueue] = useState<File[]>([]);
  const [queued, setQueued] = useState(0);
  const [editing, setEditing] = useState(false);
  const uploads = useRef<Promise<void>>(Promise.resolve());
  const pendingUploads = useRef(0);

  function choose(files: FileList | File[] | null) {
    if (!files?.length) return;
    const limit = kind === 'post' ? 10 : 1;
    const room = Math.max(0, limit - media.length - queue.length - pendingUploads.current);
    const picked = Array.from(files).slice(0, room);
    if (fileRef.current) fileRef.current.value = '';
    const videoBytes = picked.filter(isVideoFile).reduce((n, f) => n + f.size, 0);
    setVideoCost(dataSaver.active && videoBytes ? videoBytes : null);
    if (kind === 'reel' && picked.some((f) => !isVideoFile(f))) return toast(t('compose.reelIsVideo'));
    // Photos (not GIFs) and videos open in the editor first; anything else uploads as it is.
    const editable = picked.filter((f) => EDITABLE.has(f.type));
    for (const f of picked.filter((f) => !EDITABLE.has(f.type))) enqueueUpload(f, null);
    setQueue((q) => [...q, ...editable]);
    setQueued((n) => (queue.length ? n : 0) + editable.length);
  }

  // Files picked straight from Spark or the story strip's "+" arrive here, possibly for another kind.
  const [incoming, setIncoming] = useState<{ files: File[]; mode: 'post' | 'reel' | 'story' } | null>(null);
  useEffect(() => {
    const take = () => {
      const p = takePendingMedia();
      if (p) setIncoming(p);
    };
    take();
    return onPendingMedia(take);
  }, []);
  useEffect(() => {
    if (!incoming) return;
    if (incoming.mode !== kind) {
      setKind(incoming.mode);
      return; // choose() runs again once the kind has changed
    }
    // A single video picked for a post can just as well be a reel; keep it a post unless asked.
    choose(incoming.files);
    setIncoming(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incoming, kind]);

  function nextInQueue() {
    setQueue((q) => q.slice(1));
  }

  /** Upload one file (and, for an edited video, apply the edits on the server), after any upload already running. */
  function enqueueUpload(f: File, edits: EditorParamsInput | null, tags: DraftTag[] = []) {
    pendingUploads.current++;
    setUploading(true);
    uploads.current = uploads.current.then(async () => {
      try {
        if (kind === 'reel' && !edits && isVideoFile(f)) {
          // Check the length before uploading a long file for nothing.
          const seconds = await videoSeconds(f);
          if (seconds > reelMax + 0.5)
            return toast(
              me?.plus
                ? t('compose.reelTooLong', { max: reelMax / 60, length: Math.round(seconds / 60) })
                : t('compose.reelTooLongPlus', { max: reelMax / 60, plus: PLUS_REEL_MAX_SECONDS / 60, length: Math.round(seconds / 60) }),
            );
        }
        // Large files (mostly video) go through resumable, chunked uploads.
        const { media: m } = f.size > 8 * 1024 * 1024 ? await api.uploads.resumable(f, (p) => setProgress(Math.round(p * 100))) : await api.media.upload(f);
        setProgress(null);
        if (edits && m.kind === 'video') {
          setEditing(true);
          const { media: started } = await api.media.edit(m.id, edits);
          const done = await api.media.waitUntilReady(started.id);
          setMedia((cur) => [...cur, { id: done.id, kind: 'video', url: done.variants.mp4 ?? done.url, altText: '', tags: [] }]);
        } else setMedia((cur) => [...cur, { id: m.id, kind: m.kind, url: m.url, altText: '', tags: m.kind === 'image' ? tags : [] }]);
      } catch (e) {
        toast(errorMessage(e));
      } finally {
        setEditing(false);
        setProgress(null);
        pendingUploads.current--;
        if (!pendingUploads.current) setUploading(false);
      }
    });
  }

  /** A post's photos (up to 9) go into a collage; it takes the place of the first of them. */
  function openCollage() {
    const photos = media.filter((m) => m.kind === 'image').slice(0, COLLAGE_MAX_PHOTOS);
    if (photos.length < COLLAGE_MIN_PHOTOS) return toast(t('collage.needPhotos', { min: COLLAGE_MIN_PHOTOS, max: COLLAGE_MAX_PHOTOS }));
    setCollage({ photos: photos.map((m) => ({ id: m.id, url: m.url })), shape: 'square' });
  }

  /** A story's collage: the photos are picked and uploaded as they are (no editor), then put together. */
  async function collageFromFiles(files: FileList | null) {
    // Copied before the input is cleared: clearing it empties its live FileList.
    const all = Array.from(files ?? []);
    const picked = all.filter((f) => f.type.startsWith('image/') && f.type !== 'image/gif').slice(0, COLLAGE_MAX_PHOTOS);
    if (collageRef.current) collageRef.current.value = '';
    if (!all.length) return;
    if (picked.length < COLLAGE_MIN_PHOTOS) return toast(t('collage.needPhotos', { min: COLLAGE_MIN_PHOTOS, max: COLLAGE_MAX_PHOTOS }));
    setUploading(true);
    try {
      const photos: CollagePhoto[] = [];
      for (const f of picked) {
        const { media: m } = await api.media.upload(f);
        photos.push({ id: m.id, url: m.url });
      }
      setCollage({ photos, shape: 'story' });
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      if (!pendingUploads.current) setUploading(false);
    }
  }

  /** Caption ideas from what's written and the photos (and hashtags people use); nothing changes until one is picked. */
  async function suggestCaption() {
    setAiLoading(true);
    try {
      const r = await api.ai.captions({
        text: body,
        mediaIds: media
          .filter((m) => m.kind === 'image')
          .map((m) => m.id)
          .slice(0, 4),
        format: kind === 'reel' ? 'reel' : 'post',
      });
      setAi(r.ideas);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setAiLoading(false);
    }
  }

  const topicList = () =>
    topics
      .split(/[,\s#]+/)
      .filter(Boolean)
      .slice(0, 5);

  // Music goes on photo and text posts (not videos, polls or links).
  const postCanHaveMusic = !poll && media.every((m) => m.kind === 'image');

  /** What the post says and shows, for publishing it now, saving it as a draft or scheduling it. */
  function postContent(): Record<string, unknown> {
    if (kind === 'reel') {
      const v = media[0]!;
      return {
        format: 'reel',
        body,
        visibility,
        circleId: visibility === 'circle' ? circleId || undefined : undefined,
        allowRemix,
        ...(allowEchoes ? { allowEchoes } : {}),
        commentPolicy,
        // A sound plays in full instead of the video's own; a song plays the chosen part.
        ...(remixOf && original
          ? { remixOf, remixMode }
          : music?.track.source === 'library'
            ? { soundId: music.track.id }
            : music
              ? { music: { trackId: music.track.id, startMs: music.startMs, durationMs: music.durationMs } }
              : soundTitle.trim()
                ? { soundTitle: soundTitle.trim() }
                : {}),
        media: [{ id: v.id, url: new URL(v.url, location.origin).toString(), kind: 'video', altText: v.altText || undefined }],
        collaborators: collaborators.map((u) => u.id),
        topics: topicList(),
        aiAssisted: aiUsed,
      };
    }
    return {
      body,
      visibility,
      communityId: communityId || undefined,
      circleId: visibility === 'circle' ? circleId || undefined : undefined,
      audience: visibility === 'selected' && audience.length ? audience : undefined,
      media: media.map((m) => ({
        id: m.id,
        url: new URL(m.url, location.origin).toString(),
        kind: m.kind,
        altText: m.altText || undefined,
        tags: m.kind === 'image' && m.tags.length ? m.tags.map((t) => ({ userId: t.user.id, x: t.x, y: t.y })) : undefined,
      })),
      collaborators: collaborators.map((u) => u.id),
      poll: poll ? { options: poll.filter((o) => o.trim()) } : undefined,
      music: music && postCanHaveMusic ? { ...musicInput(music), x: undefined, y: undefined, style: undefined } : undefined,
      topics: topicList(),
      aiAssisted: aiUsed,
      commentPolicy,
    };
  }

  /** Keep the post for later: as a draft, or to publish at the chosen time. */
  async function keep(mode: 'draft' | 'schedule') {
    setBusy(mode);
    setError(null);
    setNeedsVerify(false);
    setFields({});
    try {
      const at = mode === 'schedule' ? new Date(when) : null;
      if (at && Number.isNaN(at.getTime())) {
        setFields({ scheduledAt: t('compose.chooseDateTime') });
        return;
      }
      const extra = at ? { scheduledAt: at.toISOString() } : { draft: true };
      if (draftId) await api.drafts.save(draftId, { ...postContent(), ...(at ? { scheduledAt: at.toISOString() } : {}) });
      else await api.posts.create({ ...postContent(), ...extra });
      toast(at ? t('m.create.scheduled', { time: formatScheduled(at.toISOString(), locale) }) : t('m.create.draftSaved'));
      router.push('/drafts');
    } catch (err) {
      if (isVerificationError(err)) setNeedsVerify(true);
      else setError(errorMessage(err));
      setFields(fieldErrors(err));
    } finally {
      setBusy(null);
    }
  }

  async function publish(e: React.FormEvent) {
    e.preventDefault();
    setBusy('publish');
    setError(null);
    setNeedsVerify(false);
    setFields({});
    try {
      if (kind === 'story') {
        await api.moments.create({
          body,
          mediaId: media[0]?.id,
          expiresIn,
          customHours: expiresIn === 'custom' ? Math.min(720, Math.max(1, Math.round(Number(customHours)) || 24)) : undefined,
          visibility,
          allowReshare,
          stickers: stickers.map(({ key: _key, label: _label, ...s }) => s),
          music: music ? musicInput(music) : undefined,
        });
        toast(t('m.create.storyShared'));
        router.push('/home');
        return;
      }
      // A draft is saved with what's here now, then published through the same checks as a new post.
      const r = draftId ? (await api.drafts.save(draftId, postContent()), await api.drafts.publish(draftId)) : await api.posts.create(postContent());
      if (kind === 'reel') {
        toast(noticeText(r.moderation, t) ?? t('compose.reelPublished'));
        router.push(`/reels?start=${r.post.id}`);
        return;
      }
      toast(noticeText(r.moderation, t) ?? t('create.published'));
      router.push(communityId ? `/c/${communities.find((c) => c.id === communityId)?.slug ?? ''}` : '/home');
    } catch (err) {
      if (isVerificationError(err)) setNeedsVerify(true);
      else setError(errorMessage(err));
      setFields(fieldErrors(err));
    } finally {
      setBusy(null);
    }
  }

  const empty =
    kind === 'reel'
      ? media.length !== 1 || media[0]!.kind !== 'video' || (!!remixOf && !original)
      : !body.trim() && !media.length && !poll && !(kind === 'story' && (stickers.length || music));
  const blocked = uploading || !draftLoaded || empty;

  return (
    <>
      <form className="yp-shell__inner" onSubmit={publish}>
        <div className="yp-topbar">
          <h1>{draftId ? t('m.create.continueDraft') : t('create.title')}</h1>
          <Link href="/drafts" className="yp-btn yp-btn--ghost yp-btn--sm">
            {t('m.create.drafts')}
          </Link>
        </div>
        {/* Double-tap Post, Reel or Story to open the camera in that mode. */}
        <div
          className="create-kinds"
          onDoubleClick={(e) => {
            // The buttons are in the same order as the kinds; their labels are translated.
            const button = (e.target as HTMLElement).closest('button');
            const picked = button ? KINDS[Array.from(e.currentTarget.querySelectorAll('button')).indexOf(button)] : undefined;
            if (picked) router.push(picked === 'post' ? '/camera' : `/camera?mode=${picked}`);
          }}
        >
          <Segments
            label={t('m.create.mode')}
            value={kind}
            onChange={(k) => {
              setKind(k);
              // Keep only what the new kind can hold.
              if (k !== 'post') {
                setPoll(null);
                setMedia((m) => m.filter((x) => k !== 'reel' || x.kind === 'video').slice(0, 1));
              }
              if (k === 'story' && (visibility === 'selected' || visibility === 'subscribers' || visibility === 'circle')) setVisibility('friends');
              // The part keeps within what the new kind plays (15 seconds on stories).
              setMusic((m) => (m ? { ...m, durationMs: Math.min(m.durationMs, clipMax(m.track, k)) } : m));
              if (k !== 'story' && visibility === 'close_friends') setVisibility('friends');
            }}
            options={KINDS.map((id) => ({ id, label: t(`m.create.mode.${id}`) }))}
          />
        </div>
        {kind === 'reel' && remixOf ? (
          originalMissing ? (
            <Alert tone="danger">{t(remixMode === 'duet' ? 'compose.duetUnavailable' : 'compose.remixUnavailable')}</Alert>
          ) : original ? (
            <div className="remix-source">
              {original.media[0] ? (
                <video
                  className="remix-source__video"
                  src={(original.media[0].variants as Record<string, string> | undefined)?.mp4 ?? original.media[0].url}
                  poster={original.media[0].posterUrl ?? undefined}
                  muted
                  playsInline
                  preload="metadata"
                  aria-hidden
                />
              ) : null}
              <div className="remix-source__text">
                <strong>{t(remixMode === 'duet' ? 'm.reels.duetWith' : 'm.reels.remixOf', { name: original.author.username })}</strong>
                <span className="muted">{t(remixMode === 'duet' ? 'compose.duetHint' : 'compose.remixHint')}</span>
                {original.sound ? <span className="muted">{t('m.create.sound', { title: original.sound.title })}</span> : null}
              </div>
            </div>
          ) : (
            <p className="muted">{t('compose.loadingOriginal')}</p>
          )
        ) : null}
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          {kind === 'post' ? t('compose.hint.post') : kind === 'reel' ? t('compose.hint.reel', { minutes: reelMax / 60 }) : t('compose.hint.story')}
        </p>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {needsVerify || (me?.needsVerification && kind !== 'story' && (visibility === 'public' || !!communityId)) ? <VerifyPrompt action="post" /> : null}

        <div className="composer-box">
          <label htmlFor="body" className="yp-visually-hidden">
            {t('create.placeholder')}
          </label>
          <AutocompleteText
            id="body"
            value={body}
            onValueChange={setBody}
            placeholder={t(kind === 'reel' ? 'm.create.reel.caption' : kind === 'story' ? 'm.create.story.body' : 'create.placeholder')}
            maxLength={kind === 'story' ? 500 : kind === 'reel' ? 2200 : 5000}
            aria-invalid={!!fields.body}
          />
          {fields.body ? <span className="yp-field__error">{fields.body}</span> : null}
          {kind === 'post' && communityId && communities.find((c) => c.id === communityId) ? (
            <SimilarQuestions slug={communities.find((c) => c.id === communityId)!.slug} text={body} />
          ) : null}

          {media.length ? (
            <div className="thumbs">
              {media.map((m, i) => (
                <div key={m.id} className="stack-sm" style={{ width: 96 }}>
                  <figure>
                    {m.kind === 'video' ? <video src={m.url} muted /> : <img src={m.url} alt={m.altText} />}
                    <button type="button" aria-label={t('m.common.remove')} onClick={() => setMedia((cur) => cur.filter((x) => x.id !== m.id))}>
                      ×
                    </button>
                  </figure>
                  <input
                    className="yp-input"
                    style={{ height: 32, fontSize: 12 }}
                    placeholder={t('compose.altText')}
                    aria-label={t('compose.altTextLabel', { number: i + 1 })}
                    value={m.altText}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      setMedia((cur) => cur.map((x) => (x.id === m.id ? { ...x, altText: v } : x)));
                    }}
                  />
                  {m.kind === 'image' ? (
                    <SuggestAltText
                      mediaId={m.id}
                      index={i}
                      compact
                      onSuggested={(text) => setMedia((cur) => cur.map((x) => (x.id === m.id ? { ...x, altText: text.slice(0, 500) } : x)))}
                    />
                  ) : null}
                  {m.kind === 'image' && kind !== 'story' ? (
                    <button
                      type="button"
                      className="thumb-tag"
                      onClick={() => setTaggingId(m.id)}
                      aria-label={m.tags.length ? tp('compose.editTags', m.tags.length, { number: i + 1 }) : t('compose.tagImage', { number: i + 1 })}
                    >
                      {m.tags.length ? t('compose.tagged', { count: m.tags.length }) : t('m.tags.add')}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {poll ? (
            <div className="stack-sm">
              {poll.map((o, i) => (
                <input
                  key={i}
                  className="yp-input"
                  placeholder={t('m.sticker.option', { number: i + 1 })}
                  aria-label={t('compose.pollOption', { number: i + 1 })}
                  value={o}
                  maxLength={80}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    setPoll((p) => p!.map((x, j) => (j === i ? v : x)));
                  }}
                />
              ))}
              <div className="row">
                {poll.length < 6 ? (
                  <Button size="sm" variant="ghost" onClick={() => setPoll((p) => [...p!, ''])}>
                    {t('compose.addOption')}
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => setPoll(null)}>
                  {t('compose.removePoll')}
                </Button>
              </div>
            </div>
          ) : null}

          {videoCost ? (
            <Alert tone="warning" title={t('dataSaver.title')} onDismiss={() => setVideoCost(null)} locale={locale}>
              {t('dataSaver.videoSize', { size: formatBytes(videoCost) })} {t('dataSaver.videoWifi')}
            </Alert>
          ) : null}
          <div className="row">
            <input
              ref={fileRef}
              type="file"
              accept={kind === 'reel' ? VIDEO_ACCEPT : MEDIA_ACCEPT}
              multiple={kind === 'post'}
              hidden
              onChange={(e) => choose(e.currentTarget.files)}
            />
            <Button size="sm" variant="secondary" icon="image" loading={uploading} onClick={() => fileRef.current?.click()}>
              {editing
                ? t('m.editor.applying')
                : progress !== null
                  ? t('m.cover.uploading', { progress: new Intl.NumberFormat(locale, { style: 'percent' }).format(progress / 100) })
                  : t(kind === 'reel' ? (media.length ? 'm.create.replaceVideo' : 'm.create.chooseVideo') : 'm.create.choosePhotoVideo')}
            </Button>
            {kind === 'post' && media.filter((m) => m.kind === 'image').length >= COLLAGE_MIN_PHOTOS ? (
              <Button size="sm" variant="secondary" icon="image" disabled={uploading} onClick={openCollage}>
                {t('collage.make')}
              </Button>
            ) : null}
            {kind === 'story' ? (
              <>
                <input ref={collageRef} type="file" accept="image/*" multiple hidden onChange={(e) => collageFromFiles(e.currentTarget.files)} />
                <Button size="sm" variant="secondary" icon="image" disabled={uploading} onClick={() => collageRef.current?.click()}>
                  {t('collage.fromPhotos')}
                </Button>
              </>
            ) : null}
            {kind === 'post' && !poll ? (
              <Button size="sm" variant="secondary" icon="poll" onClick={() => setPoll(['', ''])}>
                {t('m.sticker.kind.poll')}
              </Button>
            ) : null}
            {flags.AI_CAPTIONS && (body.trim() || media.some((m) => m.kind === 'image')) ? (
              <Button size="sm" variant="ghost" icon="sparkle" loading={aiLoading} onClick={suggestCaption}>
                {t('create.aiCaption')}
              </Button>
            ) : null}
          </div>
        </div>

        {ai ? (
          <CaptionIdeasPanel
            ideas={ai}
            onUse={(caption) => {
              // Keep the hashtags already written; the idea replaces the rest.
              const tags = body.match(/(^|\s)#[\p{L}\p{M}\p{N}_]+/gu)?.join('') ?? '';
              setBody(`${caption}${tags}`.slice(0, 5000));
              setAiUsed(true);
            }}
            onAddTag={(tag) => setBody((b) => `${b.trimEnd()} #${tag}`.trimStart())}
            onClose={() => setAi(null)}
          />
        ) : null}

        {kind !== 'story' ? (
          <PeoplePicker
            label={t('compose.coAuthors')}
            hint={t('compose.coAuthorsHint')}
            scope="mutuals"
            max={MAX_COLLABORATORS}
            canPick={() => true}
            picked={collaborators}
            onChange={setCollaborators}
          />
        ) : null}
        {kind === 'story' ? (
          <>
            {media[0]?.kind !== 'audio' ? (
              <MusicField use="story" value={music} onChange={setMusic} video={media[0]?.kind === 'video'}>
                {music ? (
                  <Segments
                    label={t('m.music.style')}
                    value={music.style}
                    onChange={(style) => setMusic({ ...music, style })}
                    options={[
                      { id: 'compact', label: t('m.music.compact') },
                      { id: 'card', label: t('m.music.card') },
                    ]}
                  />
                ) : null}
              </MusicField>
            ) : null}
            <StoryStickerEditor
              stickers={stickers}
              onChange={setStickers}
              preview={{ mediaUrl: media[0]?.url, mediaKind: media[0]?.kind, body }}
              music={music ? { title: music.track.title, artist: music.track.artist, style: music.style, x: music.x, y: music.y } : null}
              onMoveMusic={(x, y) => setMusic((m) => (m ? { ...m, x, y } : m))}
            />
          </>
        ) : null}

        {kind === 'reel' && !remixOf ? (
          <div className="stack-sm">
            <MusicField use="reel" value={music} onChange={setMusic} />
            {music ? null : (
              <TextField
                label={t('compose.soundName')}
                hint={t('compose.soundNameHint')}
                value={soundTitle}
                maxLength={100}
                onChange={(e) => setSoundTitle(e.currentTarget.value)}
              />
            )}
          </div>
        ) : null}
        {kind === 'post' && postCanHaveMusic ? <MusicField use="post" value={music} onChange={setMusic} /> : null}

        <div className="stack">
          {kind === 'reel' ? null : kind === 'post' ? (
            <Select label={t('compose.postIn')} value={communityId} onChange={(e) => setCommunityId(e.currentTarget.value)}>
              <option value="">{t('compose.myProfile')}</option>
              {communities.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          ) : (
            <Select label={t('m.create.expires')} value={expiresIn} onChange={(e) => setExpiresIn(e.currentTarget.value as typeof expiresIn)}>
              <option value="1h">{t('m.create.expires.1h')}</option>
              <option value="24h">{t('m.create.expires.24h')}</option>
              <option value="permanent">{t('m.create.expires.permanent')}</option>
              <option value="custom">{t('m.create.expires.custom')}</option>
            </Select>
          )}
          {kind === 'story' && expiresIn === 'custom' ? (
            <TextField
              label={t('m.create.expires.hours')}
              type="number"
              inputMode="numeric"
              min={1}
              max={720}
              step={1}
              value={customHours}
              onChange={(e) => setCustomHours(e.currentTarget.value)}
            />
          ) : null}
          {!communityId ? (
            <Select
              label={t('create.visibility')}
              // Each circle is its own choice ("Circle: Family"), so the picker shows which one.
              value={visibility === 'circle' ? `circle:${circleId}` : visibility}
              onChange={(e) => {
                const v = e.currentTarget.value;
                if (v.startsWith('circle:')) {
                  setVisibility('circle');
                  setCircleId(v.slice('circle:'.length));
                } else setVisibility(v as Audience);
              }}
            >
              {(kind === 'story' ? STORY_VISIBILITIES : POST_VISIBILITIES)
                // Stories can't go to a circle; they have close friends instead.
                .filter((v) => (kind !== 'story' || (v !== 'selected' && v !== 'subscribers' && v !== 'circle')) && (v !== 'subscribers' || hasPlans))
                .flatMap((v) =>
                  v === 'circle'
                    ? circles.length
                      ? circles.map((c) => (
                          <option key={`circle:${c.id}`} value={`circle:${c.id}`}>
                            {t('m.create.circle', { name: c.name })}
                          </option>
                        ))
                      : [
                          <option key="circle" value="circle:" disabled>
                            {t('compose.circleMakeFirst')}
                          </option>,
                        ]
                    : [
                        <option key={v} value={v}>
                          {t(`visibility.${v}` as MessageKey)}
                        </option>,
                      ],
                )}
            </Select>
          ) : null}
          {kind !== 'story' ? (
            <Select label={t('comments.settings.title')} value={commentPolicy} onChange={(e) => setCommentPolicy(e.currentTarget.value as CommentPolicy)}>
              {COMMENT_POLICIES.map((p) => (
                <option key={p} value={p}>
                  {t(`comments.policy.${p}`)}
                </option>
              ))}
            </Select>
          ) : null}
          {kind === 'story' ? (
            <Checkbox
              label={t('m.stories.allowReshare')}
              description={t('compose.allowReshareHint')}
              checked={allowReshare}
              onChange={(e) => setAllowReshare(e.currentTarget.checked)}
            />
          ) : null}
          {kind === 'story' && visibility === 'close_friends' ? (
            <p className="muted" style={{ margin: 0, fontSize: 14 }}>
              {t('compose.closeFriendsHint')} <Link href="/settings/privacy#close-friends">{t('compose.editList')}</Link>
            </p>
          ) : null}
          {kind === 'reel' ? (
            <Checkbox
              label={t('compose.allowRemix')}
              description={t('compose.allowRemixHint')}
              checked={allowRemix}
              onChange={(e) => setAllowRemix(e.currentTarget.checked)}
            />
          ) : null}
          {kind === 'reel' ? (
            <Select
              label={t('echo.settings')}
              hint={allowEchoes ? t('echo.settings.hint') : t('echo.settings.defaultHint')}
              value={allowEchoes}
              onChange={(e) => setAllowEchoes(e.currentTarget.value as EchoPermission | '')}
            >
              <option value="">{t('echo.settings.default')}</option>
              {ECHO_PERMISSIONS.map((p) => (
                <option key={p} value={p}>
                  {t(`echo.settings.${p}`)}
                </option>
              ))}
            </Select>
          ) : null}
          {visibility === 'subscribers' && !communityId && kind !== 'story' ? (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {t('compose.subscribersHint')}
            </p>
          ) : null}
          {kind !== 'story' && !communityId ? (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {visibility === 'circle' && circles.some((c) => c.id === circleId) ? (
                <>{t('compose.circleOnly', { name: circles.find((c) => c.id === circleId)!.name })} </>
              ) : circles.length ? null : (
                <>{t('compose.circleIntro')} </>
              )}
              <Link href="/circles">{t(circles.length ? 'compose.manageCircles' : 'compose.makeCircle')}</Link>
            </p>
          ) : null}
          {kind !== 'story' ? (
            <TextField label={t('compose.topics')} hint={t('compose.topicsHint')} value={topics} onChange={(e) => setTopics(e.currentTarget.value)} />
          ) : null}
          {aiUsed ? <Checkbox label={t('compose.aiLabel')} checked readOnly disabled /> : null}
        </div>

        <Button type="submit" size="lg" block loading={busy === 'publish'} disabled={blocked || !!busy}>
          {t(
            kind === 'story'
              ? visibility === 'close_friends'
                ? 'compose.shareCloseFriends'
                : 'm.create.shareStory'
              : kind === 'reel'
                ? remixOf
                  ? remixMode === 'duet'
                    ? 'compose.publishDuet'
                    : 'compose.publishRemix'
                  : 'm.create.publishReel'
                : 'create.publish',
          )}
        </Button>
        {kind !== 'story' ? (
          <div className="stack-sm">
            <div className="row">
              <Button variant="secondary" loading={busy === 'draft'} disabled={blocked || !!busy} onClick={() => keep('draft')}>
                {t('m.create.saveDraft')}
              </Button>
              <Button variant="ghost" icon="calendar" aria-expanded={scheduling} onClick={() => setScheduling((v) => !v)}>
                {t('m.create.schedule')}
              </Button>
            </div>
            {scheduling ? (
              <div className="stack-sm">
                <TextField
                  label={t('compose.publishOn')}
                  type="datetime-local"
                  value={when}
                  {...scheduleBounds()}
                  hint={t('compose.scheduleHint', { minutes: SCHEDULE_MIN_MINUTES, days: SCHEDULE_MAX_DAYS })}
                  error={fields.scheduledAt}
                  onChange={(e) => setWhen(e.currentTarget.value)}
                />
                <Button loading={busy === 'schedule'} disabled={blocked || !!busy || !when} onClick={() => keep('schedule')}>
                  {t('compose.schedulePost')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </form>
      {queue[0] ? (
        queue[0].type.startsWith('video/') ? (
          <VideoEditor
            key={`${queue[0].name}-${queue[0].lastModified}-${queued - queue.length}`}
            file={queue[0]}
            maxSeconds={reelMax}
            mustFit={kind === 'reel'}
            title={queued > 1 ? t('compose.editVideoN', { index: queued - queue.length + 1, total: queued }) : t('m.editor.videoTitle')}
            onDone={(edits) => {
              enqueueUpload(queue[0]!, edits);
              nextInQueue();
            }}
            onCancel={nextInQueue}
          />
        ) : (
          <PhotoEditor
            key={`${queue[0].name}-${queue[0].lastModified}-${queued - queue.length}`}
            file={queue[0]}
            title={queued > 1 ? t('compose.editPhotoN', { index: queued - queue.length + 1, total: queued }) : t('m.editor.photoTitle')}
            onDone={(edited, tags) => {
              enqueueUpload(edited, null, tags);
              nextInQueue();
            }}
            onCancel={nextInQueue}
          />
        )
      ) : null}
      {collage ? (
        <CollageEditor
          photos={collage.photos}
          shape={collage.shape}
          onCancel={() => setCollage(null)}
          onDone={(made) => {
            const used = new Set(collage.photos.map((p) => p.id));
            const item: Uploaded = { id: made.id, kind: 'image', url: made.url, altText: made.altText ?? '', tags: [] };
            setMedia((cur) => {
              if (kind === 'story') return [item];
              const at = cur.findIndex((m) => used.has(m.id));
              const rest = cur.filter((m) => !used.has(m.id));
              rest.splice(at < 0 ? rest.length : Math.min(at, rest.length), 0, item);
              return rest;
            });
            setCollage(null);
          }}
        />
      ) : null}
      <BottomSheet open={!!tagging} onClose={() => setTaggingId(null)} title={t('m.tags.add')}>
        {tagging ? (
          <div className="stack">
            <PhotoTagger
              src={tagging.url}
              alt={tagging.altText}
              tags={tagging.tags}
              onChange={(tags) => setMedia((cur) => cur.map((x) => (x.id === tagging.id ? { ...x, tags } : x)))}
            />
            <Button onClick={() => setTaggingId(null)}>{t('m.common.done')}</Button>
          </div>
        ) : null}
      </BottomSheet>
    </>
  );
}

export default function CreatePage() {
  return (
    <Suspense>
      <Create />
    </Suspense>
  );
}
