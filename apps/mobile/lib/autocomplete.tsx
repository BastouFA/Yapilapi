import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View, type NativeSyntheticEvent, type TextInput, type TextInputSelectionChangeEventData } from 'react-native';
import { client } from './api';
import { useT } from './i18n';
import { elevation, radius, space } from './theme';
import { Avatar, useColors, userText } from './ui';

type Suggestion = { key: string; insert: string; primary: string; secondary?: string; avatar?: { name: string; url: string | null } };
type Token = { kind: '@' | '#'; q: string; start: number };

/** The @name or #tag being typed right before the caret, if any (same rule as the web's AutocompleteText). */
const TOKEN = /(^|[\s(])([@#])([\p{L}\p{M}\p{N}_.]{0,30})$/u;
const DEBOUNCE_MS = 200;
const LIMIT = 6;

let trending: Promise<string[]> | null = null;
/** Trending tags, fetched once per app session (and again after a failure). */
const trendingTags = () =>
  (trending ??= client()
    .then((api) => api.trending(20))
    .then(
      (r) => r.items.map((x) => x.tag),
      () => ((trending = null), [] as string[]),
    ));

async function suggest(token: Token): Promise<Suggestion[]> {
  const api = await client();
  if (token.kind === '@') {
    const r = await api.people.suggest(token.q, LIMIT).catch(() => ({ items: [] }));
    return r.items.map(({ user }) => ({
      key: user.id,
      insert: `@${user.username} `,
      primary: user.displayName,
      secondary: `@${user.username}`,
      avatar: { name: user.displayName, url: user.avatarUrl },
    }));
  }
  const q = token.q.toLocaleLowerCase();
  const [hot, found] = await Promise.all([
    trendingTags(),
    q
      ? api
          .search(q, 'topics')
          .then((r) => ((r.results.topics ?? []) as { slug: string }[]).map((x) => x.slug))
          .catch(() => [] as string[])
      : Promise.resolve([] as string[]),
  ]);
  const tags: string[] = [];
  for (const tag of [...hot.filter((x) => x.startsWith(q)), ...found]) {
    if (tag && tag !== q && !tags.includes(tag)) tags.push(tag);
    if (tags.length >= LIMIT) break;
  }
  return tags.map((tag) => ({ key: tag, insert: `#${tag} `, primary: `#${tag}` }));
}

/**
 * Hashtag and mention suggestions for a text box. Typing @ and a letter suggests people (people
 * you know first); typing # suggests tags (trending ones, then tags people use). Picking one
 * replaces what was typed with `@username ` or `#tag `.
 *
 * `inputProps` go on the TextInput (it needs the ref and the selection events); render `list`
 * where the suggestions should show, above or below the box.
 */
export function useAutocomplete(value: string, onChangeText: (v: string) => void) {
  const ref = useRef<TextInput>(null);
  const caret = useRef(value.length);
  // The latest text: a selection event can arrive before the new value has rendered.
  const text = useRef(value);
  text.current = value;
  const [token, setToken] = useState<Token | null>(null);
  const [items, setItems] = useState<Suggestion[]>([]);
  const seq = useRef(0);

  const readToken = (text: string, at: number) => {
    const m = TOKEN.exec(text.slice(0, Math.min(at, text.length)));
    setToken(m ? { kind: m[2] as '@' | '#', q: m[3]!, start: Math.min(at, text.length) - m[3]!.length - 1 } : null);
  };

  useEffect(() => {
    const id = ++seq.current;
    if (!token || (token.kind === '@' && token.q.length < 1)) {
      setItems([]);
      return;
    }
    const timer = setTimeout(() => {
      void suggest(token).then((s) => {
        // A newer token was typed meanwhile: drop this answer.
        if (id === seq.current) setItems(s);
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [token?.kind, token?.q]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (s: Suggestion) => {
    if (!token) return;
    const cur = text.current;
    const end = Math.max(token.start + 1 + token.q.length, Math.min(caret.current, cur.length));
    const next = cur.slice(0, token.start) + s.insert + cur.slice(end);
    const pos = token.start + s.insert.length;
    seq.current++;
    text.current = next;
    onChangeText(next);
    setToken(null);
    setItems([]);
    caret.current = pos;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelection?.(pos, pos);
    });
  };

  const open = !!token && items.length > 0;

  return {
    open,
    inputProps: {
      ref,
      value,
      onChangeText: (next: string) => {
        // On most keyboards the caret is right after what was just typed; the selection event that
        // follows corrects it when not.
        const grew = next.length - text.current.length;
        caret.current = Math.max(0, Math.min(next.length, caret.current + grew));
        text.current = next;
        onChangeText(next);
        readToken(next, caret.current);
      },
      onSelectionChange: (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
        const { start, end } = e.nativeEvent.selection;
        caret.current = end;
        if (start !== end) setToken(null);
        else readToken(text.current, end);
      },
      onBlur: () => setTimeout(() => setToken(null), 150),
    },
    list: open ? <SuggestionList kind={token!.kind} items={items} onPick={pick} /> : null,
  };
}

function SuggestionList({ kind, items, onPick }: { kind: '@' | '#'; items: Suggestion[]; onPick: (s: Suggestion) => void }) {
  const c = useColors();
  const { t, tp } = useT();
  return (
    <View
      accessibilityRole="list"
      accessibilityLabel={kind === '@' ? t('m.ac.people') : t('m.ac.tags')}
      style={[{ backgroundColor: c.surface, borderRadius: radius.md, paddingVertical: space[1] }, elevation(c, 'lg')]}
    >
      <Text accessibilityLiveRegion="polite" style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }}>
        {tp('m.ac.count', items.length)}
      </Text>
      {items.map((s) => (
        <Pressable
          key={s.key}
          accessibilityRole="button"
          accessibilityLabel={s.secondary ? `${s.primary}, ${s.secondary}` : s.primary}
          accessibilityHint={t('m.ac.pickHint')}
          // Keep the keyboard up: the text box stays focused while a suggestion is picked.
          onPress={() => onPick(s)}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: space[2],
            paddingHorizontal: space[3],
            minHeight: 44,
            backgroundColor: pressed ? c.surfaceSunken : 'transparent',
          })}
        >
          {s.avatar ? <Avatar name={s.avatar.name} url={s.avatar.url} size={28} /> : null}
          <View style={{ flex: 1 }}>
            <Text style={[{ color: c.ink, fontWeight: '600', fontSize: 15 }, userText]} numberOfLines={1}>
              {s.primary}
            </Text>
            {s.secondary ? (
              <Text style={[{ color: c.inkMuted, fontSize: 12 }, userText]} numberOfLines={1}>
                {s.secondary}
              </Text>
            ) : null}
          </View>
        </Pressable>
      ))}
    </View>
  );
}
