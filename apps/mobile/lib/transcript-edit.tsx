import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Text, View } from 'react-native';
import type { CaptionCue, CaptionTrack } from '../../../packages/api-client/src/index';
import { transcriptErrorText } from '../../../packages/shared/src/job-failures';
import { authorTranscript, transcriptLanguage } from '../../../packages/shared/src/transcript';
import type { Post } from '../../../packages/shared/src/types';
import { client, errorMessage } from './api';
import { useT } from './i18n';
import { clock } from './media';
import { space } from './theme';
import { BottomSheet, Button, Field, Notice, useColors } from './ui';

interface Line extends CaptionCue {
  key: number;
}

/**
 * The transcript of your own audio post, to read and fix line by line (each line shows when it's
 * said). When speech-to-text is set up on the server and there's no transcript, or it failed,
 * "Make a transcript" asks for one, and the sheet says how that's going. Listeners see the saved
 * lines as the post's Transcript.
 */
export function TranscriptSheet({ post, onClose, onChanged }: { post: Post; onClose: () => void; onChanged: (post: Post) => void }) {
  const c = useColors();
  const { t, locale } = useT();
  const mediaId = post.media[0]!.id;
  const [track, setTrack] = useState<CaptionTrack | null>(null);
  const [autoCaptions, setAutoCaptions] = useState(false);
  const [lines, setLines] = useState<Line[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nextKey = useRef(0);
  // Unsaved changes; checking back on an automatic transcript never replaces them.
  const dirty = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const fallback = transcriptLanguage(locale);
  const lang = track?.lang ?? fallback.lang;
  const label = track?.label ?? fallback.label;

  /** The author's track and, when it's ready, its lines. */
  async function load(keepLines = false) {
    const api = await client();
    const r = await api.studio.captions(mediaId);
    if (!mounted.current) return;
    const mine = authorTranscript(r.items, locale);
    setTrack(mine);
    setAutoCaptions(!!r.autoCaptions);
    if (keepLines) return;
    dirty.current = false;
    if (mine?.status !== 'ready') return setLines([]);
    const cues = await api.studio.captionCues(mediaId, mine.lang);
    if (mounted.current) setLines(cues.cues.map((x) => ({ ...x, key: nextKey.current++ })));
  }

  useEffect(() => {
    load().catch((e) => setError(errorMessage(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaId]);

  // An automatic transcript takes a while: check back until it's done.
  const making = track?.status === 'processing';
  useEffect(() => {
    if (!making) return;
    const timer = setInterval(() => void load(dirty.current).catch(() => {}), 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [making]);

  const update = (key: number, text: string) => {
    dirty.current = true;
    setLines((ls) => ls?.map((l) => (l.key === key ? { ...l, text } : l)) ?? ls);
  };
  const remove = (key: number) => {
    dirty.current = true;
    setLines((ls) => ls?.filter((l) => l.key !== key) ?? ls);
  };
  const addLine = () => {
    dirty.current = true;
    setLines((ls) => {
      const last = ls?.length ? ls[ls.length - 1]!.end : 0;
      const at = Math.round(last * 10) / 10;
      return [...(ls ?? []), { key: nextKey.current++, start: at, end: Math.round((at + 2) * 10) / 10, text: '' }];
    });
  };

  /** Do something to the transcript, then show where it stands and refresh the post. */
  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    setErrors({});
    setError(null);
    setNote(null);
    try {
      await fn();
      await load();
      const fresh = await (await client()).posts.get(post.id);
      onChanged(fresh.post);
      if (mounted.current) setNote(done);
    } catch (e) {
      const fields = (e as { fields?: Record<string, string> }).fields;
      if (mounted.current) {
        setErrors(fields ?? {});
        setError(errorMessage(e));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const confirmDelete = () =>
    Alert.alert(t('transcript.deleteConfirm'), undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('m.common.delete'),
        style: 'destructive',
        onPress: () => void act(async () => (await client()).studio.deleteCaptions(mediaId, lang), t('transcript.deleted')),
      },
    ]);

  const failure = track?.status === 'failed' ? (transcriptErrorText(track, t) ?? t('transcript.error.failed')) : null;
  const canSave = !!lines?.length && lines.every((l) => l.text.trim() && l.end > l.start);

  return (
    <BottomSheet visible title={t('transcript.edit')} subtitle={t('transcript.in', { language: label })} onClose={onClose}>
      {lines === null && !error ? <ActivityIndicator color={c.yapi} /> : null}
      {making ? (
        <Text accessibilityLiveRegion="polite" style={{ color: c.ink, lineHeight: 20 }}>
          {t('transcript.making')}
        </Text>
      ) : null}
      {failure ? <Notice tone="danger">{failure}</Notice> : null}
      {lines && !lines.length && !making ? <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('transcript.none')}</Text> : null}
      {(lines ?? []).map((l, i) => {
        const time = t('transcript.cueTime', { start: clock(l.start), end: clock(l.end) });
        const lineError = errors[`cues.${i}.text`] ?? errors[`cues.${i}.start`] ?? errors[`cues.${i}.end`];
        return (
          <View key={l.key} style={{ gap: space[1], paddingBottom: space[2], borderBottomWidth: 1, borderColor: c.line }}>
            <Field
              label={t('transcript.cueText', { number: i + 1 })}
              hint={time}
              value={l.text}
              onChangeText={(v) => update(l.key, v)}
              multiline
              maxLength={1000}
              error={lineError}
              style={{ minHeight: 64, textAlignVertical: 'top', paddingTop: 12 }}
            />
            <Button
              label={t('m.common.remove')}
              accessibilityLabel={t('transcript.cueRemove', { number: i + 1 })}
              variant="ghost"
              size="sm"
              onPress={() => remove(l.key)}
            />
          </View>
        );
      })}
      {lines ? (
        <>
          <Button label={t('transcript.add')} variant="secondary" icon="add" disabled={busy} onPress={addLine} />
          <Button
            label={t('transcript.save')}
            disabled={!canSave || busy}
            onPress={() =>
              act(
                async () =>
                  (await client()).studio.saveCaptions(mediaId, lang, {
                    label,
                    cues: lines.map(({ start, end, text }) => ({ start, end, text: text.trim() })),
                  }),
                t('transcript.saved'),
              )
            }
          />
          {autoCaptions && (!track || track.status === 'failed') ? (
            <Button
              label={t('transcript.make')}
              variant="secondary"
              disabled={busy}
              onPress={() => act(async () => (await client()).studio.transcribe(mediaId, { lang, label }), t('transcript.started'))}
            />
          ) : null}
          {track && !making ? <Button label={t('transcript.delete')} variant="danger" disabled={busy} onPress={confirmDelete} /> : null}
          {!autoCaptions && (!track || track.status === 'failed') ? (
            <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('transcript.autoOff')}</Text>
          ) : null}
        </>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {note ? (
        <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 13 }}>
          {note}
        </Text>
      ) : null}
    </BottomSheet>
  );
}
