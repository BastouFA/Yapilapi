import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, Text, View, type StyleProp, type TextStyle } from 'react-native';
import type { MessageKey } from '../../../packages/shared/src/i18n-core';
import {
  baseLanguage,
  languageName,
  needsTranslation,
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
 * "See translation" on the phone: posts, comments, story text and chat messages in a
 * language the reader doesn't understand get a "See translation" link. The settings
 * ("Languages I understand", "Translate automatically") live on the account
 * (Me.translation), so they match the web app.
 */
interface TranslationCtx {
  /** Signed in and translation is turned on. */
  enabled: boolean;
  settings: TranslationSettings;
  save: (next: TranslationSettings) => Promise<void>;
}

const Ctx = createContext<TranslationCtx>({ enabled: false, settings: { languages: [], auto: false }, save: async () => {} });
export const useTranslationSettings = () => useContext(Ctx);

export function TranslationProvider({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const [flagOn, setFlagOn] = useState(false);
  // Chosen here, until /v1/auth/me catches up.
  const [chosen, setChosen] = useState<TranslationSettings | null>(null);
  useEffect(() => {
    if (!me) return;
    let live = true;
    client()
      .then((api) => api.flags())
      .then((r) => live && setFlagOn(!!r.flags.AI_TRANSLATION))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [me]);
  useEffect(() => setChosen(null), [me?.translation]);
  const settings = chosen ?? me?.translation ?? { languages: [], auto: false };
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
  const value = useMemo(() => ({ enabled: !!me && flagOn, settings, save }), [me, flagOn, settings, save]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// Translations fetched this session, so scrolling back doesn't ask again.
const fetched = new Map<string, Translation>();

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
}

function errorKey(e: unknown): MessageKey {
  const err = e as { status?: number; code?: string };
  if (err?.code === 'translation_limit' || err?.status === 429) return 'translate.limit';
  if (err?.code === 'translation_off') return 'translate.off';
  return 'translate.failed';
}

/** State for one piece of text; `own` is text the reader wrote, never offered for translation. */
export function useTranslatable(item: { kind: TranslatableKind; id: string; text: string; lang?: string | null; own?: boolean }): Translatable {
  const { enabled, settings } = useContext(Ctx);
  const { lang: appLang } = useT();
  const target = baseLanguage(appLang);
  const offered = enabled && !item.own && !!item.text.trim() && needsTranslation(item.lang, appLang, settings.languages);
  const key = `${item.kind}:${item.id}:${target}:${item.text}`;
  const [state, setState] = useState<{ key: string; status: Status; translation: Translation | null; error: MessageKey | null }>({
    key,
    status: 'idle',
    translation: null,
    error: null,
  });
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
    if (!offered) return;
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
  }, [offered, key, item.kind, item.id, target]);
  const showOriginal = useCallback(() => setState((s) => ({ ...s, key, status: 'original' })), [key]);

  // Translate automatically: once per text, and not again after "See original".
  const auto = settings.auto && offered && current.status === 'idle';
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

/** "See translation", or "Translated from French · See original" and "Machine translation". */
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
      <View style={{ gap: 1, marginTop: 2 }} accessibilityLiveRegion="polite">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
          <Text style={[small, { color: muted }]}>{from} · </Text>
          <Pressable accessibilityRole="button" onPress={state.showOriginal} hitSlop={linkSlop} style={linkBox}>
            <Text style={[small, { color: link, fontWeight: '700' }]}>{t('translate.seeOriginal')}</Text>
          </Pressable>
        </View>
        <Text style={[small, { color: muted }]}>{t('translate.machine')}</Text>
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
 * Text that offers "See translation". The translation is shown in place of the
 * original, with accessibilityLanguage set so screen readers use the right voice.
 * `rich` shows #tags and @names as links.
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
    <View>
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
