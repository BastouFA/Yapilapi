import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  baseLanguage,
  languageName,
  needsTranslation,
  t,
  TRANSLATION_BATCH_MAX,
  worthTranslating,
  type CaptionTrackRef,
  type MessageKey,
  type TranslatableKind,
  type Translation,
  type TranslationBatch,
} from '@yapilapi/shared';

/**
 * "See translation" and automatic translation (docs/product/speak-any-language.md). Apps
 * provide who is reading (their app language, the other languages they understand, whether
 * translations show by themselves) and how to ask the API; posts, comments, stories and
 * messages in a language the reader doesn't understand then either show "See translation",
 * or, automatically, the translation with "Translated from French · See original". Without
 * a provider (signed out, or translation turned off) nothing is offered.
 */
export interface TranslationContextValue {
  /** The app's language (BCP 47): translations are made into it. */
  locale: string;
  /** Other languages the reader understands (Me.translation.languages). */
  languages: readonly string[];
  /** Show translations by themselves: the reader's switch (Me.translation.auto), and it works on the server (flags autoTranslation). */
  auto: boolean;
  translate: (kind: TranslatableKind, id: string, target: string) => Promise<Translation>;
  /** POST /v1/translations: what's on screen, in batches. Needed for `auto`. */
  translateMany?: (items: { kind: TranslatableKind; id: string }[], target: string) => Promise<TranslationBatch>;
  /** A video's caption track translated into `target` (WebVTT), offered in the player as "French (translated)". */
  captionUrl?: (mediaId: string, lang: string, target: string) => string;
}

const TranslationContext = createContext<TranslationContextValue | null>(null);

export function TranslationProvider({ value, children }: { value: TranslationContextValue | null; children: ReactNode }) {
  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}

// ── This session's memory ───────────────────────────────────────────────────
// Translations already fetched, so scrolling back or re-rendering doesn't ask again (by item, target and text).
const fetched = new Map<string, Translation>();
// What the reader chose for an item ("See original" or "See translation"), kept while the page is open.
const chosen = new Map<string, 'original' | 'translated'>();
// Items asked about automatically already (by item, target and text): never asked again by themselves.
const tried = new Set<string>();

// ── Asking for what's on screen, in batches ─────────────────────────────────
const DEBOUNCE_MS = 120;
const PENDING_RETRY_MS = 1500;
const PENDING_TRIES = 4;
// After the server says automatic translation is paused (a limit), stop asking for a while.
const PAUSE_MS = 5 * 60_000;

interface Wanted {
  kind: TranslatableKind;
  id: string;
  target: string;
  send: NonNullable<TranslationContextValue['translateMany']>;
  tries: number;
  resolve: (t: Translation | null) => void;
}
const queue = new Map<string, Wanted>();
const asking = new Map<string, Promise<Translation | null>>();
let timer: ReturnType<typeof setTimeout> | null = null;
let pausedUntil = 0;

function schedule() {
  if (!timer) timer = setTimeout(flush, DEBOUNCE_MS);
}

function flush() {
  timer = null;
  const all = [...queue.values()];
  queue.clear();
  // One request per target language and up to TRANSLATION_BATCH_MAX items.
  const groups = new Map<string, Wanted[]>();
  for (const w of all) groups.set(w.target, [...(groups.get(w.target) ?? []), w]);
  for (const [target, list] of groups)
    for (let i = 0; i < list.length; i += TRANSLATION_BATCH_MAX) {
      const chunk = list.slice(i, i + TRANSLATION_BATCH_MAX);
      chunk[0]!
        .send(
          chunk.map((w) => ({ kind: w.kind, id: w.id })),
          target,
        )
        .then(
          (res) => {
            if (!res.auto) pausedUntil = Date.now() + PAUSE_MS;
            const got = new Map(res.items.map((tr) => [`${tr.kind}:${tr.id}`, tr]));
            const pending = new Set(res.pending.map((p) => `${p.kind}:${p.id}`));
            for (const w of chunk) {
              const k = `${w.kind}:${w.id}`;
              const tr = got.get(k);
              if (tr) w.resolve(tr);
              else if (pending.has(k) && w.tries < PENDING_TRIES) {
                // Still being made: ask again in a moment.
                w.tries++;
                setTimeout(() => {
                  queue.set(`${k}:${w.target}`, w);
                  schedule();
                }, PENDING_RETRY_MS);
              } else w.resolve(null);
            }
          },
          () => chunk.forEach((w) => w.resolve(null)),
        );
    }
}

/** The automatic translation of one item: batched with the others on screen, null when there's none (it keeps "See translation"). */
function autoTranslation(send: Wanted['send'], kind: TranslatableKind, id: string, target: string): Promise<Translation | null> {
  if (Date.now() < pausedUntil) return Promise.resolve(null);
  const key = `${kind}:${id}:${target}`;
  const running = asking.get(key);
  if (running) return running;
  const p = new Promise<Translation | null>((resolve) => {
    queue.set(key, { kind, id, target, send, tries: 0, resolve });
    schedule();
  }).finally(() => asking.delete(key));
  asking.set(key, p);
  return p;
}

// One observer for every piece of text: it's on screen (or about to be) once it's within 300px.
let observer: IntersectionObserver | null = null;
const watched = new Map<Element, () => void>();
function watch(el: Element, onSeen: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    onSeen();
    return () => {};
  }
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries)
        if (e.isIntersecting) {
          const fn = watched.get(e.target);
          watched.delete(e.target);
          observer?.unobserve(e.target);
          fn?.();
        }
    },
    { rootMargin: '300px 0px' },
  );
  watched.set(el, onSeen);
  observer.observe(el);
  return () => {
    watched.delete(el);
    observer?.unobserve(el);
  };
}

type Status = 'idle' | 'loading' | 'shown' | 'original' | 'error';

export interface Translatable {
  /** "See translation" applies here: the text is in a language the reader doesn't understand. */
  offered: boolean;
  status: Status;
  /** The text to show now: the translation while it's shown, otherwise the original. */
  text: string;
  /** The language of the shown text when it's a translation (for the lang attribute). */
  lang: string | undefined;
  translation: Translation | null;
  error: MessageKey | null;
  see: () => void;
  showOriginal: () => void;
  /** Put on the element that shows the text: automatic translation waits until it's on screen. */
  ref: (el: Element | null) => void;
}

/** What went wrong, in words the reader can act on. */
function errorKey(e: unknown): MessageKey {
  const err = e as { status?: number; code?: string };
  if (err?.code === 'translation_limit' || err?.status === 429) return 'translate.limit';
  if (err?.code === 'translation_off') return 'translate.off';
  return 'translate.failed';
}

/**
 * State for one piece of text. `lang` is the language the API detected for it; `own`
 * is text the reader wrote themselves, which is never offered for translation. With
 * automatic translation, the translation is asked for once the text comes on screen
 * (with the rest on screen, in one request) and shown in its place; "See original" and
 * "See translation" switch back and forth, and the choice is kept for the session.
 */
export function useTranslatable(item: { kind: TranslatableKind; id: string; text: string; lang?: string | null; own?: boolean }): Translatable {
  const ctx = useContext(TranslationContext);
  const target = baseLanguage(ctx?.locale ?? 'en');
  const offered = !!ctx && !item.own && !!item.text.trim() && needsTranslation(item.lang, ctx.locale, ctx.languages);
  const key = `${item.kind}:${item.id}:${target}:${item.text}`;
  const itemKey = `${item.kind}:${item.id}`;
  // Already fetched, and the reader wants it (automatically, or they chose it): shown from the start, without a flash of the original.
  const initial = (): { key: string; status: Status; translation: Translation | null; error: MessageKey | null } => {
    const hit = offered ? fetched.get(key) : undefined;
    const want = chosen.get(itemKey) === 'translated' || (!!ctx?.auto && chosen.get(itemKey) !== 'original');
    return hit && want ? { key, status: 'shown', translation: hit, error: null } : { key, status: 'idle', translation: null, error: null };
  };
  const [state, setState] = useState(initial);
  // The text changed (an edit): start again.
  const current = state.key === key ? state : initial();
  const live = useRef(true);
  useEffect(() => {
    // Set again on mount: development mode mounts twice.
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const see = useCallback(() => {
    if (!ctx || !offered) return;
    chosen.set(itemKey, 'translated');
    const hit = fetched.get(key);
    if (hit) {
      setState({ key, status: 'shown', translation: hit, error: null });
      return;
    }
    setState({ key, status: 'loading', translation: null, error: null });
    ctx.translate(item.kind, item.id, target).then(
      (tr) => {
        fetched.set(key, tr);
        if (live.current) setState({ key, status: 'shown', translation: tr, error: null });
      },
      (e) => {
        if (live.current) setState({ key, status: 'error', translation: null, error: errorKey(e) });
      },
    );
  }, [ctx, offered, key, itemKey, item.kind, item.id, target]);

  const showOriginal = useCallback(() => {
    chosen.set(itemKey, 'original');
    setState((s) => ({ ...s, key, status: 'original' }));
  }, [key, itemKey]);

  // Automatic translation: once per text, never after "See original", and only on screen.
  const send = ctx?.translateMany;
  const wants =
    !!ctx?.auto && !!send && offered && current.status === 'idle' && chosen.get(itemKey) !== 'original' && !tried.has(key) && worthTranslating(item.text);
  const node = useRef<Element | null>(null);
  const ref = useCallback((el: Element | null) => {
    node.current = el;
  }, []);
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    if (!wants || onScreen) return;
    // Text shown without the ref counts as on screen.
    if (!node.current) {
      setOnScreen(true);
      return;
    }
    return watch(node.current, () => setOnScreen(true));
  }, [wants, onScreen]);
  useEffect(() => {
    if (!wants || !onScreen || !send) return;
    tried.add(key);
    setState({ key, status: 'loading', translation: null, error: null });
    void autoTranslation(send, item.kind, item.id, target).then((tr) => {
      if (tr) fetched.set(key, tr);
      if (!live.current) return;
      // Nothing to show (a limit, or too short): "See translation" as before.
      setState((s) => (s.key !== key || s.status !== 'loading' ? s : tr ? { key, status: 'shown', translation: tr, error: null } : { ...s, status: 'idle' }));
    });
  }, [wants, onScreen, send, key, item.kind, item.id, target]);

  const shown = current.status === 'shown' && !!current.translation;
  return {
    offered,
    status: current.status,
    text: shown ? current.translation!.text : item.text,
    lang: shown ? current.translation!.targetLanguage : undefined,
    translation: current.translation,
    error: current.error,
    see,
    showOriginal,
    ref,
  };
}

/**
 * The line under translatable text: "See translation", or, while a translation is shown,
 * "Translated from French · See original" (screen readers also hear "Machine translation").
 */
export function TranslationBar({ state, locale = 'en', className }: { state: Translatable; locale?: string; className?: string }) {
  if (!state.offered) return null;
  const tt = (k: MessageKey, vars?: Record<string, string | number>) => t(k, locale, vars);
  const shown = state.status === 'shown' && state.translation;
  return (
    <div className={['yp-translate', className].filter(Boolean).join(' ')} aria-live="polite">
      {shown ? (
        <span title={tt('translate.machine')}>
          {tt('translate.from', { language: languageName(state.translation!.sourceLanguage, locale) })}
          <span className="yp-visually-hidden"> ({tt('translate.machine')})</span>
          {' · '}
          <button type="button" className="yp-translate__link" onClick={state.showOriginal}>
            {tt('translate.seeOriginal')}
          </button>
        </span>
      ) : (
        <>
          <button type="button" className="yp-translate__link" onClick={state.see} disabled={state.status === 'loading'} aria-busy={state.status === 'loading'}>
            {state.status === 'loading' ? tt('translate.loading') : tt('translate.see')}
          </button>
          {state.error ? (
            <span className="yp-translate__error" role="status">
              {tt(state.error)}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Text that offers "See translation": the original (or its translation, marked with
 * its language for screen readers and spell checkers) followed by the translation bar.
 * `render` draws the text (for example with #tags and @names as links).
 */
export function TranslatableText({
  kind,
  id,
  text,
  lang,
  own,
  locale = 'en',
  className,
  render = (s) => s,
}: {
  kind: TranslatableKind;
  id: string;
  text: string;
  lang?: string | null;
  /** The reader wrote it: no "See translation". */
  own?: boolean;
  locale?: string;
  className?: string;
  render?: (text: string) => ReactNode;
}) {
  const state = useTranslatable({ kind, id, text, lang, own });
  return (
    <>
      <div ref={state.ref} className={className} dir="auto" lang={state.lang}>
        {render(state.text)}
      </div>
      <TranslationBar state={state} locale={locale} />
    </>
  );
}

/** The id of the translated caption track, which players leave off until it's chosen (so it's only made when wanted). */
export const TRANSLATED_TRACK_ID = 'yp-translated-captions';

/**
 * A caption track in the reader's language, made from one of the video's own tracks when it
 * has none in that language and automatic translation works: offered in the player's caption
 * menu as "French (translated)". Null otherwise.
 */
export function useTranslatedCaptions(
  mediaId: string | null | undefined,
  captions: CaptionTrackRef[] | null | undefined,
): { src: string; lang: string; label: string } | null {
  const ctx = useContext(TranslationContext);
  if (!ctx?.captionUrl || !mediaId || !captions?.length) return null;
  const target = baseLanguage(ctx.locale);
  if (captions.some((c) => baseLanguage(c.lang) === target)) return null;
  const from = captions[0]!;
  return {
    src: ctx.captionUrl(mediaId, from.lang, target),
    lang: target,
    label: t('translate.captionTrack', ctx.locale, { language: languageName(target, ctx.locale) }),
  };
}
