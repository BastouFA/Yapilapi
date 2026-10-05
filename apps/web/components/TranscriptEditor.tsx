'use client';

import { useEffect, useRef, useState } from 'react';
import { BottomSheet, Button, Skeleton, TextField } from '@yapilapi/design-system';
import type { CaptionCue, CaptionTrack } from '@yapilapi/api-client';
import { authorTranscript, transcriptErrorText, transcriptLanguage, type Post } from '@yapilapi/shared';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { useSession } from '@/app/providers';

interface Line extends CaptionCue {
  key: number;
}

/**
 * The transcript of your own audio post, to read and fix: each line with when it starts and ends,
 * in your language (or the only one there is). When speech-to-text is set up on the server and
 * there's no transcript, or it failed, "Make a transcript" asks for one, and the sheet says how
 * that's going. Listeners see the saved lines as the post's Transcript.
 */
export function TranscriptSheet({ post, onClose, onChanged }: { post: Post | null; onClose: () => void; onChanged: (post: Post) => void }) {
  const { t, toast, locale } = useSession();
  const mediaId = post?.media[0]?.id ?? null;
  const [track, setTrack] = useState<CaptionTrack | null>(null);
  const [autoCaptions, setAutoCaptions] = useState(false);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const nextKey = useRef(0);
  // Unsaved changes; checking back on an automatic transcript never replaces them.
  const dirty = useRef(false);
  const fallback = transcriptLanguage(locale);
  const lang = track?.lang ?? fallback.lang;

  /** The author's track and, when it's ready, its lines. */
  const load = async (keepLines = false) => {
    if (!mediaId) return null;
    const r = await api.studio.captions(mediaId);
    const mine = authorTranscript(r.items, locale);
    setTrack(mine);
    setAutoCaptions(!!r.autoCaptions);
    if (keepLines) return mine;
    dirty.current = false;
    if (mine?.status !== 'ready') {
      setLines([]);
      return mine;
    }
    const cues = await api.studio.captionCues(mediaId, mine.lang);
    setLines(cues.cues.map((c) => ({ ...c, key: nextKey.current++ })));
    return mine;
  };

  useEffect(() => {
    setTrack(null);
    setLines(null);
    setErrors({});
    if (!mediaId) return;
    load().catch((e) => {
      toast(errorMessage(e));
      onClose();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaId]);

  // An automatic transcript takes a while: check back until it's done.
  const making = track?.status === 'processing';
  useEffect(() => {
    if (!making) return;
    const timer = setInterval(() => void load(dirty.current).catch(() => {}), 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [making, mediaId]);

  const update = (key: number, patch: Partial<CaptionCue>) => {
    dirty.current = true;
    setLines((ls) => ls?.map((l) => (l.key === key ? { ...l, ...patch } : l)) ?? ls);
  };
  const addLine = () => {
    dirty.current = true;
    setLines((ls) => {
      const at = Math.round((ls?.at(-1)?.end ?? 0) * 10) / 10;
      return [...(ls ?? []), { key: nextKey.current++, start: at, end: Math.round((at + 2) * 10) / 10, text: '' }];
    });
  };

  /** Do something to the transcript, then show where it stands and refresh the post. */
  const act = async (fn: () => Promise<unknown>, done: string) => {
    if (!post || !mediaId) return;
    setBusy(true);
    setErrors({});
    try {
      await fn();
      toast(done);
      await load();
      onChanged((await api.posts.get(post.id)).post);
    } catch (e) {
      setErrors(fieldErrors(e));
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const failure = track?.status === 'failed' ? (transcriptErrorText(track, t) ?? t('transcript.error.failed')) : null;
  const canSave = !!lines?.length && lines.every((l) => l.text.trim() && l.end > l.start);

  return (
    <BottomSheet open={!!post} onClose={onClose} title={t('transcript.edit')}>
      {lines === null ? (
        <div className="stack-sm" aria-busy>
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      ) : (
        <div className="stack-sm">
          <p className="muted" style={{ margin: 0 }}>
            {t('transcript.in', { language: track?.label ?? fallback.label })}
          </p>
          <div aria-live="polite">
            {making ? <p style={{ margin: 0 }}>{t('transcript.making')}</p> : null}
            {failure ? <p className="yp-field__error">{failure}</p> : null}
          </div>
          {!lines.length && !making ? (
            <p className="muted" style={{ margin: 0 }}>
              {t('transcript.none')}
            </p>
          ) : null}

          <ol className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label={t('ds.audio.transcript')}>
            {lines.map((l, i) => (
              <li key={l.key} className="stack-sm" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 12 }}>
                <div className="row" style={{ alignItems: 'flex-end' }}>
                  <TextField
                    label={t('m.editor.start')}
                    type="number"
                    min={0}
                    step={0.1}
                    value={l.start}
                    onChange={(e) => update(l.key, { start: Number(e.currentTarget.value) })}
                    aria-label={t('transcript.cueStart', { number: i + 1 })}
                    error={errors[`cues.${i}.start`]}
                    style={{ width: 96 }}
                  />
                  <TextField
                    label={t('m.editor.end')}
                    type="number"
                    min={0}
                    step={0.1}
                    value={l.end}
                    onChange={(e) => update(l.key, { end: Number(e.currentTarget.value) })}
                    aria-label={t('transcript.cueEnd', { number: i + 1 })}
                    error={l.end <= l.start ? t('videoEditor.captions.endsBefore') : errors[`cues.${i}.end`]}
                    style={{ width: 96 }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => ((dirty.current = true), setLines((ls) => ls?.filter((x) => x.key !== l.key) ?? ls))}
                    aria-label={t('transcript.cueRemove', { number: i + 1 })}
                  >
                    {t('m.common.remove')}
                  </Button>
                </div>
                <TextField
                  label={t('m.post.text')}
                  multiline
                  rows={2}
                  value={l.text}
                  maxLength={1000}
                  lang={lang}
                  onChange={(e) => update(l.key, { text: e.currentTarget.value })}
                  aria-label={t('transcript.cueText', { number: i + 1 })}
                  error={errors[`cues.${i}.text`]}
                />
              </li>
            ))}
          </ol>

          <div className="row">
            <Button variant="secondary" onClick={addLine} disabled={busy}>
              {t('transcript.add')}
            </Button>
            <Button
              loading={busy}
              disabled={!canSave}
              onClick={() =>
                act(
                  () =>
                    api.studio.saveCaptions(mediaId!, lang, {
                      label: track?.label ?? fallback.label,
                      cues: lines.map(({ start, end, text }) => ({ start, end, text: text.trim() })),
                    }),
                  t('transcript.saved'),
                )
              }
            >
              {t('transcript.save')}
            </Button>
            {autoCaptions && (!track || track.status === 'failed') ? (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => act(() => api.studio.transcribe(mediaId!, { lang, label: track?.label ?? fallback.label }), t('transcript.started'))}
              >
                {t('transcript.make')}
              </Button>
            ) : null}
            {track && !making ? (
              <Button variant="danger" disabled={busy} onClick={() => act(() => api.studio.deleteCaptions(mediaId!, track.lang), t('transcript.deleted'))}>
                {t('transcript.delete')}
              </Button>
            ) : null}
          </div>
          {!autoCaptions && (!track || track.status === 'failed') ? (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {t('transcript.autoOff')}
            </p>
          ) : null}
        </div>
      )}
    </BottomSheet>
  );
}
