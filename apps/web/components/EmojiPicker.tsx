'use client';

import { startTransition, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { Icon } from '@yapilapi/design-system';
import { inTone, readTone, rememberReaction, SKIN_TONES, withTone, type MessageKey, type SkinTone } from '@yapilapi/shared';
import type { EmojiGroupId } from '@yapilapi/shared/emoji-data';
import { useSession } from '@/app/providers';

// ── Your emojis: the ones you used lately, kept on this device ──
const RECENT_KEY = 'ypl.reactions.recent';
const NO_RECENT: string[] = [];
let recent: string[] | null = null;
const recentListeners = new Set<() => void>();
function readRecent(): string[] {
  if (recent) return recent;
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    recent = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    recent = [];
  }
  return recent;
}
export function noteEmoji(emoji: string) {
  recent = rememberReaction(readRecent(), emoji);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    /* storage off: remembered for this visit */
  }
  recentListeners.forEach((l) => l());
}
export function useRecentEmojis(): string[] {
  return useSyncExternalStore(
    (l) => (recentListeners.add(l), () => void recentListeners.delete(l)),
    readRecent,
    () => NO_RECENT,
  );
}

// ── Your skin colour for emojis, kept on this device ──
const TONE_KEY = 'ypl.reactions.tone';
let tone: SkinTone | null = null;
const toneListeners = new Set<() => void>();
function readSkinTone(): SkinTone {
  if (tone !== null) return tone;
  try {
    tone = readTone(localStorage.getItem(TONE_KEY));
  } catch {
    tone = '';
  }
  return tone;
}
function chooseSkinTone(next: SkinTone) {
  tone = next;
  try {
    localStorage.setItem(TONE_KEY, next);
  } catch {
    /* storage off: remembered for this visit */
  }
  toneListeners.forEach((l) => l());
}
export function useSkinTone(): SkinTone {
  return useSyncExternalStore(
    (l) => (toneListeners.add(l), () => void toneListeners.delete(l)),
    readSkinTone,
    () => '',
  );
}

type EmojiData = typeof import('@yapilapi/shared/emoji-data');

/** Each kind's tab. */
const TAB_GLYPH: Record<EmojiGroupId, string> = {
  smileys: '😀',
  animals: '🐻',
  food: '🍔',
  activity: '⚽',
  travel: '🚗',
  objects: '💡',
  symbols: '🔣',
  flags: '🏳️',
};

/**
 * Every emoji: search on top, a tab for each kind (the ones you used lately first), and your skin
 * colour, which stays chosen. The list itself loads when this opens. One big grid, walked with the
 * arrow keys, so a keyboard doesn't have to Tab through nearly two thousand buttons.
 */
export function EmojiPicker({
  lit = [],
  onPick,
  onBackspace,
}: {
  /** Shown as chosen (the reactions you already gave). */
  lit?: string[];
  onPick: (emoji: string, from: HTMLElement, byPointer: boolean) => void;
  /** Takes one back from what you're writing. */
  onBackspace?: () => void;
}) {
  const { t } = useSession();
  const [data, setData] = useState<EmojiData | null>(null);
  const [query, setQuery] = useState('');
  const [tonesOpen, setTonesOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [everything, setEverything] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const recentOnes = useRecentEmojis();
  const skinTone = useSkinTone();
  useEffect(() => {
    let on = true;
    void import('@yapilapi/shared/emoji-data').then((d) => {
      if (!on) return;
      setData(d);
      // What's on screen first, so it opens at once; the other kinds right after.
      startTransition(() => setEverything(true));
    });
    return () => {
      on = false;
    };
  }, []);
  const groups = useMemo(() => {
    const kinds = (data?.EMOJI_GROUPS ?? []).slice(0, everything ? undefined : 1).map((g) => ({
      id: g.id as string,
      emojis: inTone(
        g.entries.map((e) => e.emoji),
        skinTone,
      ),
    }));
    return recentOnes.length ? [{ id: 'recent', emojis: inTone(recentOnes, skinTone) }, ...kinds] : kinds;
  }, [data, everything, recentOnes, skinTone]);
  const found = useMemo(() => {
    if (!data || !query.trim()) return null;
    return inTone(
      data.searchEmojis(query).map((e) => e.emoji),
      skinTone,
    );
  }, [data, query, skinTone]);

  // The tab of what's on screen now.
  useEffect(() => {
    const root = body.current;
    if (!root || found) return;
    const onScroll = () => {
      const top = root.getBoundingClientRect().top + 8;
      const sections = [...root.querySelectorAll<HTMLElement>('section')];
      setActive((sections.findLast((s) => s.getBoundingClientRect().top <= top) ?? sections[0])?.dataset.group ?? null);
    };
    onScroll();
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, [groups, found]);

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(body.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const across = Math.max(1, Math.round((body.current?.clientWidth ?? 308) / (items[i]!.offsetWidth + 2)));
    const to = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + across, ArrowUp: i - across, Home: 0, End: items.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, to))]?.focus();
  };
  let first = true;
  const cell = (emoji: string) => {
    const on = first;
    first = false;
    return (
      <button
        key={emoji}
        type="button"
        className="emoji-panel__emoji"
        tabIndex={on ? 0 : -1}
        aria-label={t('m.chat.reactWith', { emoji })}
        aria-pressed={lit.includes(emoji)}
        onClick={(ev) => onPick(emoji, ev.currentTarget, ev.detail > 0)}
      >
        {emoji}
      </button>
    );
  };

  return (
    <div className="emoji-panel">
      <div className="emoji-panel__top">
        <input
          className="yp-input emoji-panel__search"
          type="search"
          value={query}
          placeholder={t('emoji.search')}
          aria-label={t('emoji.search')}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <button
          type="button"
          className="emoji-panel__tone"
          aria-label={t('emoji.skinTone')}
          title={t('emoji.skinTone')}
          aria-expanded={tonesOpen}
          onClick={() => setTonesOpen((v) => !v)}
        >
          {withTone('👋', skinTone)}
        </button>
        {onBackspace ? (
          <button type="button" className="yp-action" aria-label={t('emoji.backspace')} title={t('emoji.backspace')} onClick={onBackspace}>
            <Icon name="backspace" size={20} />
          </button>
        ) : null}
      </div>
      {tonesOpen ? (
        <div className="emoji-panel__tone-row" role="group" aria-label={t('emoji.skinTone')}>
          {SKIN_TONES.map((option, i) => (
            <button
              key={option || 'yellow'}
              type="button"
              className="emoji-panel__tone"
              aria-label={t(`emoji.tone${i}` as MessageKey)}
              title={t(`emoji.tone${i}` as MessageKey)}
              aria-pressed={skinTone === option}
              onClick={() => {
                chooseSkinTone(option);
                setTonesOpen(false);
              }}
            >
              {withTone('👋', option)}
            </button>
          ))}
        </div>
      ) : null}
      {!found ? (
        <div className="emoji-panel__tabs" role="group" aria-label={t('chat.reactMore')}>
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              className="emoji-panel__tab"
              aria-label={t(`emoji.${g.id}` as MessageKey)}
              title={t(`emoji.${g.id}` as MessageKey)}
              aria-current={active === g.id ? 'true' : undefined}
              onClick={() => body.current?.querySelector(`[data-group="${g.id}"]`)?.scrollIntoView({ block: 'start' })}
            >
              {g.id === 'recent' ? <Icon name="clock" size={20} /> : TAB_GLYPH[g.id as EmojiGroupId]}
            </button>
          ))}
        </div>
      ) : null}
      <div className="emoji-panel__body" ref={body} onKeyDown={onGridKey}>
        {found ? (
          found.length ? (
            <div className="emoji-panel__grid">{found.map(cell)}</div>
          ) : (
            <p className="muted emoji-panel__none">{t('emoji.none')}</p>
          )
        ) : (
          groups.map((g) => (
            <section key={g.id} data-group={g.id} aria-labelledby={`emoji-${g.id}-h`} className="emoji-panel__section">
              <h3 className="emoji-panel__heading" id={`emoji-${g.id}-h`}>
                {t(`emoji.${g.id}` as MessageKey)}
              </h3>
              <div className="emoji-panel__grid">{g.emojis.map(cell)}</div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
