import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { baseLanguage, languageName, needsTranslation, t, type MessageKey, type TranslatableKind, type Translation } from '@yapilapi/shared';

/**
 * "See translation". Apps provide who is reading (their app language, the other
 * languages they understand, "Translate automatically") and how to ask the API for
 * a translation; posts, comments, stories and messages then offer "See translation"
 * under text in a language the reader doesn't understand. Without a provider
 * (signed out, or translation turned off) nothing is offered.
 */
export interface TranslationContextValue {
  /** The app's language (BCP 47): translations are made into it. */
  locale: string;
  /** Other languages the reader understands (Me.translation.languages). */
  languages: readonly string[];
  /** Me.translation.auto: show translations straight away. */
  auto: boolean;
  translate: (kind: TranslatableKind, id: string, target: string) => Promise<Translation>;
}

const TranslationContext = createContext<TranslationContextValue | null>(null);

export function TranslationProvider({ value, children }: { value: TranslationContextValue | null; children: ReactNode }) {
  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}

// Translations already fetched this session, so scrolling back or re-rendering doesn't ask again.
const fetched = new Map<string, Translation>();

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
 * is text the reader wrote themselves, which is never offered for translation.
 * With "Translate automatically" on, the translation is fetched and shown at once.
 */
export function useTranslatable(item: { kind: TranslatableKind; id: string; text: string; lang?: string | null; own?: boolean }): Translatable {
  const ctx = useContext(TranslationContext);
  const target = baseLanguage(ctx?.locale ?? 'en');
  const offered = !!ctx && !item.own && !!item.text.trim() && needsTranslation(item.lang, ctx.locale, ctx.languages);
  const key = `${item.kind}:${item.id}:${target}:${item.text}`;
  const [state, setState] = useState<{ key: string; status: Status; translation: Translation | null; error: MessageKey | null }>(() => ({
    key,
    status: 'idle',
    translation: null,
    error: null,
  }));
  // The text changed (an edit): start again from the original.
  const current = state.key === key ? state : { key, status: 'idle' as Status, translation: null, error: null };
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
  }, [ctx, offered, key, item.kind, item.id, target]);

  const showOriginal = useCallback(() => setState((s) => ({ ...s, key, status: 'original' })), [key]);

  // Translate automatically: once per text, and never again after "See original".
  const auto = !!ctx?.auto && offered && current.status === 'idle';
  useEffect(() => {
    if (auto) see();
  }, [auto, see]);

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
  };
}

/**
 * The line under translatable text: "See translation", or, while a translation is
 * shown, "Translated from French · See original" and "Machine translation".
 */
export function TranslationBar({ state, locale = 'en', className }: { state: Translatable; locale?: string; className?: string }) {
  if (!state.offered) return null;
  const tt = (k: MessageKey, vars?: Record<string, string | number>) => t(k, locale, vars);
  const shown = state.status === 'shown' && state.translation;
  return (
    <div className={['yp-translate', className].filter(Boolean).join(' ')} aria-live="polite">
      {shown ? (
        <>
          <span>
            {tt('translate.from', { language: languageName(state.translation!.sourceLanguage, locale) })}
            {' · '}
            <button type="button" className="yp-translate__link" onClick={state.showOriginal}>
              {tt('translate.seeOriginal')}
            </button>
          </span>
          <span className="yp-translate__note">{tt('translate.machine')}</span>
        </>
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
      <div className={className} dir="auto" lang={state.lang}>
        {render(state.text)}
      </div>
      <TranslationBar state={state} locale={locale} />
    </>
  );
}
