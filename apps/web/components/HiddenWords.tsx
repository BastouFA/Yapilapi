'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Card, Icon } from '@yapilapi/design-system';
import { HIDDEN_WORD_MAX, HIDDEN_WORDS_MAX } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

/**
 * Hidden words: comments on your posts that contain one are hidden from
 * everyone but their writer; you review them on each post.
 */
export function HiddenWordsCard() {
  const { t, toast } = useSession();
  const [words, setWords] = useState<string[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  // Where focus goes once the list has re-rendered (the next word, or the box).
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const el = !busy && pendingFocus.current ? document.getElementById(pendingFocus.current) : null;
    if (el) {
      el.focus();
      pendingFocus.current = null;
    }
  });
  useEffect(() => {
    api.me.hiddenWords().then(
      (r) => setWords(r.words),
      () => setWords([]),
    );
  }, []);

  const save = async (next: string[], focusAfter?: string) => {
    pendingFocus.current = focusAfter ?? null;
    const before = words;
    setWords(next);
    setBusy(true);
    try {
      setWords((await api.me.setHiddenWords(next)).words);
      toast(t('hiddenWords.saved'));
    } catch (e) {
      setWords(before);
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!words) return null;
  const full = words.length >= HIDDEN_WORDS_MAX;
  return (
    <Card title={t('hiddenWords.title')} subtitle={t('hiddenWords.body')}>
      <form
        className="row"
        style={{ gap: 8, alignItems: 'flex-end' }}
        onSubmit={(e) => {
          e.preventDefault();
          const w = draft.trim().toLowerCase().replace(/\s+/g, ' ');
          if (!w || words.includes(w)) return setDraft('');
          setDraft('');
          void save([...words, w], 'hidden-word-input');
        }}
      >
        <div className="yp-field" style={{ flex: 1 }}>
          <label className="yp-field__label" htmlFor="hidden-word-input">
            {t('hiddenWords.label')}
          </label>
          <input
            id="hidden-word-input"
            className="yp-input"
            value={draft}
            maxLength={HIDDEN_WORD_MAX}
            disabled={full}
            placeholder={t('hiddenWords.placeholder')}
            onChange={(e) => setDraft(e.currentTarget.value)}
            autoComplete="off"
          />
        </div>
        <Button type="submit" variant="secondary" disabled={!draft.trim() || full} loading={busy}>
          {t('hiddenWords.add')}
        </Button>
      </form>
      {full ? (
        <p className="muted setting-hint" role="status">
          {t('hiddenWords.max', { count: HIDDEN_WORDS_MAX })}
        </p>
      ) : null}
      {words.length ? (
        <ul className="row" style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', gap: 8, flexWrap: 'wrap' }}>
          {words.map((w, i) => (
            <li key={w}>
              <button
                type="button"
                id={`hidden-word-${i}`}
                className="yp-chip"
                aria-label={t('hiddenWords.remove', { word: w })}
                disabled={busy}
                onClick={() => {
                  const next = words.filter((x) => x !== w);
                  // Focus moves to the next word, or back to the box when none are left.
                  void save(next, next.length ? `hidden-word-${Math.min(i, next.length - 1)}` : 'hidden-word-input');
                }}
              >
                {w}
                <Icon name="x" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted setting-hint">{t('hiddenWords.none')}</p>
      )}
    </Card>
  );
}
