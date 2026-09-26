'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { AutocompleteText } from '@/components/Autocomplete';
import { Suspense, useEffect, useRef, useState } from 'react';
import { AIPanel, Alert, Button, Checkbox, Segments, Select, TextField } from '@yapilapi/design-system';
import { VISIBILITIES, type Community, type EditorParamsInput, type MessageKey, type Visibility } from '@yapilapi/shared';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { SimilarQuestions } from '@/components/CommunityExtras';
import { PhotoEditor } from '@/components/editor/PhotoEditor';
import { VideoEditor } from '@/components/editor/VideoEditor';
import { useSession } from '../../providers';

type Uploaded = { id: string; kind: 'image' | 'video' | 'audio'; url: string; altText: string };

/** Reels: 3 minutes, or 10 minutes with YAPILAPI Plus (the API enforces the same limits). */
const REEL_MAX_SECONDS = 180;
const PLUS_REEL_MAX_SECONDS = 600;

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
  const { t, toast, me } = useSession();
  const reelMax = me?.plus ? PLUS_REEL_MAX_SECONDS : REEL_MAX_SECONDS;
  const router = useRouter();
  const params = useSearchParams();
  const initialMode = params.get('mode') === 'reel' ? 'reel' : params.get('mode') === 'story' || params.get('moment') ? 'story' : 'post';
  const [kind, setKind] = useState<'post' | 'reel' | 'story'>(initialMode);
  const [body, setBody] = useState(() => (params.get('text') ?? '').slice(0, 5000));
  const [visibility, setVisibility] = useState<Visibility>(initialMode === 'story' ? 'friends' : 'public');
  const [communityId, setCommunityId] = useState(params.get('community') ?? '');
  const [communities, setCommunities] = useState<Community[]>([]);
  const [circles, setCircles] = useState<{ id: string; name: string }[]>([]);
  const [circleId, setCircleId] = useState('');
  const [media, setMedia] = useState<Uploaded[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [poll, setPoll] = useState<string[] | null>(null);
  const [topics, setTopics] = useState('');
  const [expiresIn, setExpiresIn] = useState<'1h' | '24h' | 'permanent'>('24h');
  const [ai, setAi] = useState<{ text: string; notice?: string } | null>(null);
  const [aiUsed, setAiUsed] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.communities
      .list('mine')
      .then((r) => setCommunities(r.items))
      .catch(() => {});
    api.me
      .circles()
      .then((r) => setCircles(r.items))
      .catch(() => {});
  }, []);

  // Files waiting for the editor, one at a time, and uploads running one after another.
  const [queue, setQueue] = useState<File[]>([]);
  const [queued, setQueued] = useState(0);
  const [editing, setEditing] = useState(false);
  const uploads = useRef<Promise<void>>(Promise.resolve());
  const pendingUploads = useRef(0);

  function choose(files: FileList | null) {
    if (!files?.length) return;
    const limit = kind === 'post' ? 10 : 1;
    const room = Math.max(0, limit - media.length - queue.length - pendingUploads.current);
    const picked = Array.from(files).slice(0, room);
    if (fileRef.current) fileRef.current.value = '';
    if (kind === 'reel' && picked.some((f) => !f.type.startsWith('video/'))) return toast('A reel is a video.');
    // Photos (not GIFs) and videos open in the editor first; anything else uploads as it is.
    const editable = picked.filter((f) => EDITABLE.has(f.type));
    for (const f of picked.filter((f) => !EDITABLE.has(f.type))) enqueueUpload(f, null);
    setQueue((q) => [...q, ...editable]);
    setQueued((n) => (queue.length ? n : 0) + editable.length);
  }

  function nextInQueue() {
    setQueue((q) => q.slice(1));
  }

  /** Upload one file (and, for an edited video, apply the edits on the server), after any upload already running. */
  function enqueueUpload(f: File, edits: EditorParamsInput | null) {
    pendingUploads.current++;
    setUploading(true);
    uploads.current = uploads.current.then(async () => {
      try {
        if (kind === 'reel' && !edits && f.type.startsWith('video/')) {
          // Check the length before uploading a long file for nothing.
          const seconds = await videoSeconds(f);
          if (seconds > reelMax + 0.5)
            return toast(
              `Reels can be up to ${reelMax / 60} minutes${me?.plus ? '' : ', or 10 minutes with YAPILAPI Plus'}. This one is ${Math.round(seconds / 60)} minutes; trim it in the editor.`,
            );
        }
        // Large files (mostly video) go through resumable, chunked uploads.
        const { media: m } = f.size > 8 * 1024 * 1024 ? await api.uploads.resumable(f, (p) => setProgress(Math.round(p * 100))) : await api.media.upload(f);
        setProgress(null);
        if (edits && m.kind === 'video') {
          setEditing(true);
          const { media: started } = await api.media.edit(m.id, edits);
          const done = await api.media.waitUntilReady(started.id);
          setMedia((cur) => [...cur, { id: done.id, kind: 'video', url: done.variants.mp4 ?? done.url, altText: '' }]);
        } else setMedia((cur) => [...cur, { id: m.id, kind: m.kind, url: m.url, altText: '' }]);
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

  async function suggestCaption() {
    setAiLoading(true);
    try {
      const r = await api.ai.assist({ task: 'caption', input: body || media.map((m) => m.altText).join(' ') || 'a new post' });
      setAi({ text: String(r.output ?? ''), notice: r.notice });
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setAiLoading(false);
    }
  }

  async function publish(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      if (kind === 'story') {
        await api.moments.create({ body, mediaId: media[0]?.id, expiresIn, visibility });
        toast('Added to your story');
        router.push('/home');
        return;
      }
      if (kind === 'reel') {
        const v = media[0]!;
        const r = await api.posts.create({
          format: 'reel',
          body,
          visibility,
          media: [{ id: v.id, url: new URL(v.url, location.origin).toString(), kind: 'video', altText: v.altText || undefined }],
          topics: topics
            .split(/[,\s#]+/)
            .filter(Boolean)
            .slice(0, 5),
          aiAssisted: aiUsed,
        });
        toast(r.moderation ? r.moderation.message : 'Reel published');
        router.push(`/reels?start=${r.post.id}`);
        return;
      }
      const r = await api.posts.create({
        body,
        visibility,
        communityId: communityId || undefined,
        circleId: visibility === 'circle' ? circleId || undefined : undefined,
        media: media.map((m) => ({ id: m.id, url: new URL(m.url, location.origin).toString(), kind: m.kind, altText: m.altText || undefined })),
        poll: poll ? { options: poll.filter((o) => o.trim()) } : undefined,
        topics: topics
          .split(/[,\s#]+/)
          .filter(Boolean)
          .slice(0, 5),
        aiAssisted: aiUsed,
      });
      toast(r.moderation ? r.moderation.message : t('create.published'));
      router.push(communityId ? `/c/${communities.find((c) => c.id === communityId)?.slug ?? ''}` : '/home');
    } catch (err) {
      setError(errorMessage(err));
      setFields(fieldErrors(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="yp-shell__inner" onSubmit={publish}>
        <div className="yp-topbar">
          <h1>{t('create.title')}</h1>
        </div>
        <Segments
          label="What to create"
          value={kind}
          onChange={(k) => {
            setKind(k);
            // Keep only what the new kind can hold.
            if (k !== 'post') {
              setPoll(null);
              setMedia((m) => m.filter((x) => k !== 'reel' || x.kind === 'video').slice(0, 1));
            }
            if (k === 'story' && visibility === 'selected') setVisibility('friends');
          }}
          options={[
            { id: 'post', label: 'Post' },
            { id: 'reel', label: 'Reel' },
            { id: 'story', label: 'Story' },
          ]}
        />
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          {kind === 'post'
            ? 'Text, photos, videos, a link or a poll, on your profile or in a community.'
            : kind === 'reel'
              ? `One vertical video up to ${reelMax / 60} minutes, shown full screen in Reels and on your profile.`
              : 'A photo, video or a few words for your people. It disappears when you choose.'}
        </p>
        {error ? <Alert tone="danger">{error}</Alert> : null}

        <div className="composer-box">
          <label htmlFor="body" className="yp-visually-hidden">
            {t('create.placeholder')}
          </label>
          <AutocompleteText
            id="body"
            value={body}
            onValueChange={setBody}
            placeholder={kind === 'reel' ? 'Write a caption' : kind === 'story' ? 'Add a few words (optional)' : t('create.placeholder')}
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
                    <button type="button" aria-label="Remove" onClick={() => setMedia((cur) => cur.filter((x) => x.id !== m.id))}>
                      ×
                    </button>
                  </figure>
                  <input
                    className="yp-input"
                    style={{ height: 32, fontSize: 12 }}
                    placeholder="Alt text"
                    aria-label={`Describe image ${i + 1} for people using screen readers`}
                    value={m.altText}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      setMedia((cur) => cur.map((x) => (x.id === m.id ? { ...x, altText: v } : x)));
                    }}
                  />
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
                  placeholder={`Option ${i + 1}`}
                  aria-label={`Poll option ${i + 1}`}
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
                    Add option
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => setPoll(null)}>
                  Remove poll
                </Button>
              </div>
            </div>
          ) : null}

          <div className="row">
            <input
              ref={fileRef}
              type="file"
              accept={kind === 'reel' ? 'video/mp4,video/webm' : 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm'}
              multiple={kind === 'post'}
              hidden
              onChange={(e) => choose(e.currentTarget.files)}
            />
            <Button size="sm" variant="secondary" icon="image" loading={uploading} onClick={() => fileRef.current?.click()}>
              {editing
                ? 'Applying your edits…'
                : progress !== null
                  ? `Uploading ${progress}%`
                  : kind === 'reel'
                    ? media.length
                      ? 'Replace video'
                      : 'Choose a video'
                    : 'Photo or video'}
            </Button>
            {kind === 'post' && !poll ? (
              <Button size="sm" variant="secondary" icon="poll" onClick={() => setPoll(['', ''])}>
                Poll
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" icon="sparkle" loading={aiLoading} onClick={suggestCaption}>
              {t('create.aiCaption')}
            </Button>
          </div>
        </div>

        {ai ? (
          <AIPanel
            title="Suggested caption"
            notice={ai.notice}
            actions={
              <>
                <Button
                  size="sm"
                  onClick={() => {
                    setBody(ai.text);
                    setAiUsed(true);
                    setAi(null);
                  }}
                >
                  Use this
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAi(null)}>
                  Dismiss
                </Button>
              </>
            }
          >
            {ai.text || 'No suggestion this time.'}
          </AIPanel>
        ) : null}

        <div className="stack">
          {kind === 'reel' ? null : kind === 'post' ? (
            <Select label="Post in" value={communityId} onChange={(e) => setCommunityId(e.currentTarget.value)}>
              <option value="">My profile</option>
              {communities.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          ) : (
            <Select label="Disappears after" value={expiresIn} onChange={(e) => setExpiresIn(e.currentTarget.value as typeof expiresIn)}>
              <option value="1h">1 hour</option>
              <option value="24h">24 hours</option>
              <option value="permanent">Keep it</option>
            </Select>
          )}
          {!communityId ? (
            <Select label={t('create.visibility')} value={visibility} onChange={(e) => setVisibility(e.currentTarget.value as Visibility)}>
              {VISIBILITIES.filter((v) => kind !== 'story' || v !== 'selected').map((v) => (
                <option key={v} value={v} disabled={v === 'circle' && !circles.length}>
                  {t(`visibility.${v}` as MessageKey)}
                </option>
              ))}
            </Select>
          ) : null}
          {visibility === 'circle' && !communityId ? (
            <Select label="Circle" value={circleId} onChange={(e) => setCircleId(e.currentTarget.value)}>
              <option value="">Choose a circle</option>
              {circles.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          ) : null}
          {kind !== 'story' ? (
            <TextField label="Topics (optional)" hint="Up to 5, separated by commas." value={topics} onChange={(e) => setTopics(e.currentTarget.value)} />
          ) : null}
          {aiUsed ? <Checkbox label="Label this post as made with AI assistance" checked readOnly disabled /> : null}
        </div>

        <Button
          type="submit"
          size="lg"
          block
          loading={busy}
          disabled={uploading || (kind === 'reel' ? media.length !== 1 || media[0]!.kind !== 'video' : !body.trim() && !media.length && !poll)}
        >
          {kind === 'story' ? 'Share to your story' : kind === 'reel' ? 'Publish reel' : t('create.publish')}
        </Button>
      </form>
      {queue[0] ? (
        queue[0].type.startsWith('video/') ? (
          <VideoEditor
            key={`${queue[0].name}-${queue[0].lastModified}-${queued - queue.length}`}
            file={queue[0]}
            maxSeconds={reelMax}
            mustFit={kind === 'reel'}
            title={queued > 1 ? `Edit video ${queued - queue.length + 1} of ${queued}` : 'Edit video'}
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
            title={queued > 1 ? `Edit photo ${queued - queue.length + 1} of ${queued}` : 'Edit photo'}
            onDone={(edited) => {
              enqueueUpload(edited, null);
              nextInQueue();
            }}
            onCancel={nextInQueue}
          />
        )
      ) : null}
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
