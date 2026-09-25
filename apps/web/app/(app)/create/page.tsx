'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { AIPanel, Alert, Button, Checkbox, Segments, Select, TextField } from '@yapilapi/design-system';
import { VISIBILITIES, type Community, type MessageKey, type Visibility } from '@yapilapi/shared';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { useSession } from '../../providers';

type Uploaded = { id: string; kind: 'image' | 'video' | 'audio'; url: string; altText: string };

function Create() {
  const { t, toast } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const [kind, setKind] = useState<'post' | 'moment'>(params.get('moment') ? 'moment' : 'post');
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<Visibility>(params.get('moment') ? 'friends' : 'public');
  const [communityId, setCommunityId] = useState(params.get('community') ?? '');
  const [communities, setCommunities] = useState<Community[]>([]);
  const [circles, setCircles] = useState<{ id: string; name: string }[]>([]);
  const [circleId, setCircleId] = useState('');
  const [media, setMedia] = useState<Uploaded[]>([]);
  const [uploading, setUploading] = useState(false);
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
    api.communities.list('mine').then((r) => setCommunities(r.items)).catch(() => {});
    api.me.circles().then((r) => setCircles(r.items)).catch(() => {});
  }, []);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(files).slice(0, 10 - media.length)) {
        const { media: m } = await api.media.upload(f);
        setMedia((cur) => [...cur, { id: m.id, kind: m.kind, url: m.url, altText: '' }]);
      }
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
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
      if (kind === 'moment') {
        await api.moments.create({ body, mediaUrl: media[0]?.url, mediaKind: media[0]?.kind, expiresIn, visibility });
        toast('Moment shared');
        router.push('/home');
        return;
      }
      const r = await api.posts.create({
        body,
        visibility,
        communityId: communityId || undefined,
        circleId: visibility === 'circle' ? circleId || undefined : undefined,
        media: media.map((m) => ({ url: new URL(m.url, location.origin).toString(), kind: m.kind, altText: m.altText || undefined })),
        poll: poll ? { options: poll.filter((o) => o.trim()) } : undefined,
        topics: topics.split(/[,\s#]+/).filter(Boolean).slice(0, 5),
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
    <form className="yp-shell__inner" onSubmit={publish}>
      <div className="yp-topbar">
        <h1>{t('create.title')}</h1>
      </div>
      <Segments label="What to create" value={kind} onChange={setKind} options={[{ id: 'post', label: 'Post' }, { id: 'moment', label: 'Moment' }]} />
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="composer-box">
        <label htmlFor="body" className="yp-visually-hidden">
          {t('create.placeholder')}
        </label>
        <textarea id="body" placeholder={t('create.placeholder')} value={body} onChange={(e) => setBody(e.currentTarget.value)} maxLength={kind === 'moment' ? 500 : 5000} aria-invalid={!!fields.body} />
        {fields.body ? <span className="yp-field__error">{fields.body}</span> : null}

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
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm" multiple={kind === 'post'} hidden onChange={(e) => upload(e.currentTarget.files)} />
          <Button size="sm" variant="secondary" icon="image" loading={uploading} onClick={() => fileRef.current?.click()}>
            Photo or video
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
        {kind === 'post' ? (
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
            {VISIBILITIES.filter((v) => kind === 'post' || v !== 'selected').map((v) => (
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
        {kind === 'post' ? <TextField label="Topics (optional)" hint="Up to 5, separated by commas." value={topics} onChange={(e) => setTopics(e.currentTarget.value)} /> : null}
        {aiUsed ? <Checkbox label="Label this post as made with AI assistance" checked readOnly disabled /> : null}
      </div>

      <Button type="submit" size="lg" block loading={busy} disabled={uploading || (!body.trim() && !media.length && !poll)}>
        {kind === 'moment' ? 'Share moment' : t('create.publish')}
      </Button>
    </form>
  );
}

export default function CreatePage() {
  return (
    <Suspense>
      <Create />
    </Suspense>
  );
}
