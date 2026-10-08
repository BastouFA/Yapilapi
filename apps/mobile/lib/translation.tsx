import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Dimensions, Pressable, Text, View, type StyleProp, type TextStyle } from 'react-native';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import {
  baseLanguage,
  languageName,
  needsTranslation,
  TRANSLATION_BATCH_MAX,
  worthTranslating,
  type TranslatableKind,
  type Translation,
  type TranslationSettings,
} from '../../../packages/shared/src/translation';
import { client } from './api';
import { useT } from './i18n';
import { RichText } from './rich-text';
import { useSession } from './session';
import { useColors, userText } from './ui';

/**
 * "See translation" and automatic translation on the phone (docs/product/speak-any-language.md):
 * posts, comments, story text and chat messages in a language the reader doesn't understand
 * show their translation with "Translated from French · See original", or a "See translation"
 * link when translation isn't automatic. The settings ("Languages I understand", "Translate
 * automatically") live on the account (Me.translation), so they match the web app.
 */
interface TranslationCtx {
  /** Signed in and translation is turned on. */
  enabled: boolean;
  /** Translations show by themselves: the reader's switch, and it works on the server (flags autoTranslation). */
  auto: boolean;
  /** Automatic translation works on the server (also: translated caption tracks). */
  available: boolean;
  settings: TranslationSettings;
  save: (next: TranslationSettings) => Promise<void>;
}

const Ctx = createContext<TranslationCtx>({ enabled: false, auto: false, available: false, settings: { languages: [], auto: true }, save: async () => {} });
export const useTranslationSettings = () => useContext(Ctx);

export function TranslationProvider({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const [flags, setFlags] = useState({ on: false, auto: false });
  // Chosen here, until /v1/auth/me catches up.
  const [chosen, setChosen] = useState<TranslationSettings | null>(null);
  useEffect(() => {
    if (!me) return;
    let live = true;
    client()
      .then((api) => api.flags())
      .then((r) => live && setFlags({ on: !!r.flags.AI_TRANSLATION, auto: !!r.autoTranslation }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [me]);
  useEffect(() => setChosen(null), [me?.translation]);
  const settings = chosen ?? me?.translation ?? { languages: [], auto: true };
  const save = useCallback(
    async (next: TranslationSettings) => {
      const before = chosen;
      setChosen(next);
      try {
        await (await client()).me.setTranslation(next);
      } catch (e) {
        setChosen(before);
        throw e;
      }
    },
    [chosen],
  );
  const value = useMemo(() => {
    const enabled = !!me && flags.on;
    return { enabled, auto: enabled && flags.auto && settings.auto, available: enabled && flags.auto, settings, save };
  }, [me, flags, settings, save]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// ── This session's memory ───────────────────────────────────────────────────
// Translations fetched, so scrolling back doesn't ask again (by item, target and text).
const fetched = new Map<string, Translation>();
// What the reader chose for an item ("See original" or "See translation"), kept while the app runs.
const chosenFor = new Map<string, 'original' | 'translated'>();
// Items asked about automatically already: never asked again by themselves.
const tried = new Set<string>();

// ── Asking for what's on screen, in batches (POST /v1/translations) ─────────
const DEBOUNCE_MS = 150;
const PENDING_RETRY_MS = 1500;
const PENDING_TRIES = 4;
// After the server says automatic translation is paused (a limit), stop asking for a while.
const PAUSE_MS = 5 * 60_000;

interface Wanted {
  kind: TranslatableKind;
  id: string;
  target: string;
  tries: number;
  resolve: (t: Translation | null) => void;
}
const queue = new Map<string, Wanted>();
const asking = new Map<string, Promise<Translation | null>>();
let timer: ReturnType<typeof setTimeout> | null = null;
let pausedUntil = 0;

function schedule() {
  if (!timer) timer = setTimeout(() => void flush(), DEBOUNCE_MS);
}

async function flush() {
  timer = null;
  const all = [...queue.values()];
  queue.clear();
  const groups = new Map<string, Wanted[]>();
  for (const w of all) groups.set(w.target, [...(groups.get(w.target) ?? []), w]);
  for (const [target, list] of groups)
    for (let i = 0; i < list.length; i += TRANSLATION_BATCH_MAX) {
      const chunk = list.slice(i, i + TRANSLATION_BATCH_MAX);
      try {
        const res = await (await client()).translations({ target, items: chunk.map((w) => ({ kind: w.kind, id: w.id })) });
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
      } catch {
        chunk.forEach((w) => w.resolve(null));
      }
    }
}

function autoTranslation(kind: TranslatableKind, id: string, target: string): Promise<Translation | null> {
  if (Date.now() < pausedUntil) return Promise.resolve(null);
  const key = `${kind}:${id}:${target}`;
  const running = asking.get(key);
  if (running) return running;
  const p = new Promise<Translation | null>((resolve) => {
    queue.set(key, { kind, id, target, tries: 0, resolve });
    schedule();
  }).finally(() => asking.delete(key));
  asking.set(key, p);
  return p;
}

// ── On screen ───────────────────────────────────────────────────────────────
// React Native has no intersection observer: text waiting for a translation is measured a few
// times a second (one timer for all of it) until it's on screen or about to be.
const AHEAD = 300;
const waitingViews = new Map<View, () => void>();
let ticker: ReturnType<typeof setInterval> | null = null;
function checkOnScreen() {
  const { height } = Dimensions.get('window');
  for (const [view, onSeen] of waitingViews)
    view.measureInWindow((_x, y, w, h) => {
      if (!waitingViews.has(view) || (!w && !h)) return;
      if (y + h > -AHEAD && y < height + AHEAD) {
        waitingViews.delete(view);
        onSeen();
      }
    });
  if (!waitingViews.size && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}
function watch(view: View, onSeen: () => void): () => void {
  waitingViews.set(view, onSeen);
  ticker ??= setInterval(checkOnScreen, 400);
  // The first look right away (after layout).
  setTimeout(checkOnScreen, 50);
  return () => {
    waitingViews.delete(view);
  };
}

type Status = 'idle' | 'loading' | 'shown' | 'original' | 'error';

export interface Translatable {
  offered: boolean;
  status: Status;
  /** What to show now: the translation while it's shown, otherwise the original. */
  text: string;
  /** Language of the shown text when it's a translation (for accessibilityLanguage). */
  lang: string | undefined;
  translation: Translation | null;
  error: MessageKey | null;
  see: () => void;
  showOriginal: () => void;
  /** Put on the View around the text: automatic translation waits until it's on screen. */
  ref: (view: View | null) => void;
}

function errorKey(e: unknown): MessageKey {
  const err = e as { status?: number; code?: string };
  if (err?.code === 'translation_limit' || err?.status === 429) return 'translate.limit';
  if (err?.code === 'translation_off') return 'translate.off';
  return 'translate.failed';
}

/**
 * State for one piece of text; `own` is text the reader wrote, never offered for translation.
 * With automatic translation, it's asked for once the text is on screen (with the rest on
 * screen, in one request) and shown in place; "See original" and "See translation" switch
 * back and forth, and the choice is kept while the app runs.
 */
export function useTranslatable(item: { kind: TranslatableKind; id: string; text: string; lang?: string | null; own?: boolean }): Translatable {
  const { enabled, auto, settings } = useContext(Ctx);
  const { lang: appLang } = useT();
  const target = baseLanguage(appLang);
  const offered = enabled && !item.own && !!item.text.trim() && needsTranslation(item.lang, appLang, settings.languages);
  const key = `${item.kind}:${item.id}:${target}:${item.text}`;
  const itemKey = `${item.kind}:${item.id}`;
  const initial = (): { key: string; status: Status; translation: Translation | null; error: MessageKey | null } => {
    const hit = offered ? fetched.get(key) : undefined;
    const want = chosenFor.get(itemKey) === 'translated' || (auto && chosenFor.get(itemKey) !== 'original');
    return hit && want ? { key, status: 'shown', translation: hit, error: null } : { key, status: 'idle', translation: null, error: null };
  };
  const [state, setState] = useState(initial);
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
    if (!offered) return;
    chosenFor.set(itemKey, 'translated');
    const hit = fetched.get(key);
    if (hit) return setState({ key, status: 'shown', translation: hit, error: null });
    setState({ key, status: 'loading', translation: null, error: null });
    client()
      .then((api) => api.translate({ kind: item.kind, id: item.id, target }))
      .then(
        (r) => {
          fetched.set(key, r.translation);
          if (live.current) setState({ key, status: 'shown', translation: r.translation, error: null });
        },
        (e) => {
          if (live.current) setState({ key, status: 'error', translation: null, error: errorKey(e) });
        },
      );
  }, [offered, key, itemKey, item.kind, item.id, target]);
  const showOriginal = useCallback(() => {
    chosenFor.set(itemKey, 'original');
    setState((s) => ({ ...s, key, status: 'original' }));
  }, [key, itemKey]);

  // Automatic translation: once per text, never after "See original", and only on screen.
  const wants = auto && offered && current.status === 'idle' && chosenFor.get(itemKey) !== 'original' && !tried.has(key) && worthTranslating(item.text);
  const node = useRef<View | null>(null);
  const ref = useCallback((view: View | null) => {
    node.current = view;
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
    if (!wants || !onScreen) return;
    tried.add(key);
    setState({ key, status: 'loading', translation: null, error: null });
    void autoTranslation(item.kind, item.id, target).then((tr) => {
      if (tr) fetched.set(key, tr);
      if (!live.current) return;
      // Nothing to show (a limit, or too short): "See translation" as before.
      setState((s) => (s.key !== key || s.status !== 'loading' ? s : tr ? { key, status: 'shown', translation: tr, error: null } : { ...s, status: 'idle' }));
    });
  }, [wants, onScreen, key, item.kind, item.id, target]);

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

/** "See translation", or "Translated from French · See original" (screen readers also hear "Machine translation"). */
export function TranslationBar({ state, tint, linkTint }: { state: Translatable; tint?: string; linkTint?: string }) {
  const c = useColors();
  const { t, locale } = useT();
  if (!state.offered) return null;
  const muted = tint ?? c.inkMuted;
  const link = linkTint ?? c.yapi;
  const small = { fontSize: 12, lineHeight: 17 } as const;
  // The links are 32 tall and their slop reaches 44: 2 up (only the gap, since the text above can
  // hold #tag and @name links) and 10 down.
  const linkBox = { minHeight: 32, justifyContent: 'center' } as const;
  const linkSlop = { top: 2, bottom: 10, left: 8, right: 8 };
  if (state.status === 'shown' && state.translation) {
    const from = t('translate.from', { language: languageName(state.translation.sourceLanguage, locale) });
    return (
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 2 }} accessibilityLiveRegion="polite">
        <Text style={[small, { color: muted }]} accessibilityLabel={`${from} (${t('translate.machine')})`}>
          {from} ·{' '}
        </Text>
        <Pressable accessibilityRole="button" onPress={state.showOriginal} hitSlop={linkSlop} style={linkBox}>
          <Text style={[small, { color: link, fontWeight: '700' }]}>{t('translate.seeOriginal')}</Text>
        </Pressable>
      </View>
    );
  }
  const loading = state.status === 'loading';
  return (
    <View style={{ gap: 1, marginTop: 2 }} accessibilityLiveRegion="polite">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: loading, busy: loading }}
        disabled={loading}
        onPress={state.see}
        hitSlop={linkSlop}
        style={[linkBox, { alignSelf: 'flex-start' }]}
      >
        <Text style={[small, { color: loading ? muted : link, fontWeight: '700' }]}>{loading ? t('translate.loading') : t('translate.see')}</Text>
      </Pressable>
      {state.error ? <Text style={[small, { color: muted }]}>{t(state.error)}</Text> : null}
    </View>
  );
}

/**
 * Text that offers "See translation", or shows its translation by itself. The translation is
 * shown in place of the original, with accessibilityLanguage set so screen readers use the
 * right voice. `rich` shows #tags and @names as links.
 */
export function TranslatableText({
  kind,
  id,
  text,
  lang,
  own,
  style,
  rich = true,
  tint,
  linkTint,
}: {
  kind: TranslatableKind;
  id: string;
  text: string;
  lang?: string | null;
  own?: boolean;
  style?: StyleProp<TextStyle>;
  rich?: boolean;
  tint?: string;
  linkTint?: string;
}) {
  const state = useTranslatable({ kind, id, text, lang, own });
  return (
    <View ref={state.ref} collapsable={false}>
      {rich ? (
        <RichText text={state.text} style={style} language={state.lang} />
      ) : (
        <Text style={[style, userText]} accessibilityLanguage={state.lang}>
          {state.text}
        </Text>
      )}
      <TranslationBar state={state} tint={tint} linkTint={linkTint} />
    </View>
  );
}
