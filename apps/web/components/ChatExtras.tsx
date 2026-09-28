'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { BottomSheet, Button, Icon } from '@yapilapi/design-system';
import {
  chatTheme,
  chessDrawReason,
  DISAPPEARING_SECONDS,
  messagePreviewText,
  type Message,
  type MessageKey,
  type MessagePreview,
  type PinnedMessage,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** Quick reactions offered on every message. */
export const QUICK_REACTIONS = ['❤️', '😂', '😮', '😢', '👍', '🙏'] as const;

const DISAPPEARING_LABEL: Record<number, MessageKey> = { 86400: 'm.chat.hours24', 604800: 'm.chat.days7', 7776000: 'm.chat.days90' };
export const disappearingLabel = (t: T, seconds: number | null | undefined) => {
  if (!seconds) return t('m.chat.off');
  const key = DISAPPEARING_LABEL[seconds];
  return key ? t(key) : t('m.unit.seconds', { count: seconds });
};

/**
 * A one-line description of a quoted message, in the reader's language (messagePreviewText in
 * packages/shared). `meId` says whose story a story reply answered; `locale` formats amounts.
 */
export function previewText(t: T, p: MessagePreview, o: { meId?: string; locale?: string } = {}): string {
  return messagePreviewText(p, { t, ...o });
}

/** The quoted original inside a reply bubble. Selecting it scrolls to the original. */
export function MessageQuote({ preview, mine, meId, onJump }: { preview: MessagePreview; mine: boolean; meId?: string; onJump: (id: string) => void }) {
  const { t, locale } = useSession();
  const who = !preview.available ? null : preview.sender?.id === meId ? t('m.chat.you') : preview.sender?.displayName;
  const text = previewText(t, preview, { meId, locale });
  return (
    <button
      type="button"
      className={`chat-quote${mine ? ' chat-quote--mine' : ''}`}
      disabled={!preview.available}
      onClick={() => onJump(preview.id)}
      aria-label={preview.available ? t('chat.goToWithText', { name: who ?? '', text }) : text}
    >
      {who ? <bdi className="chat-quote__who">{who}</bdi> : null}
      <span className="chat-quote__text" dir="auto">
        {text}
      </span>
    </button>
  );
}

/** Reaction counts under a bubble; selecting one adds or removes yours. */
export function ReactionRow({ message, mine, onToggle }: { message: Message; mine: boolean; onToggle: (emoji: string, on: boolean) => void }) {
  const { tp } = useSession();
  if (!message.reactions?.length) return null;
  return (
    <div className={`chat-reactions${mine ? ' chat-reactions--mine' : ''}`}>
      {message.reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          className={`chat-reaction${r.mine ? ' chat-reaction--mine' : ''}`}
          // A toggle: the name stays the same and aria-pressed says whether you reacted.
          aria-pressed={r.mine}
          aria-label={tp('m.chat.reactionCount', r.count, { emoji: r.emoji })}
          onClick={() => onToggle(r.emoji, !r.mine)}
        >
          <span aria-hidden>{r.emoji}</span>
          <span className="chat-reaction__count">{r.count}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The row of quick reactions, shown from a message's actions. Focus moves to the first one;
 * arrows move between them; Escape closes it and focus goes back to where it came from (the
 * React button or the message menu), as does picking one.
 */
export function ReactionPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const { t } = useSession();
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    // Once: in development React runs this twice, and by then focus is already inside.
    opener.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector('button')?.focus();
    const outside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close.current();
    };
    document.addEventListener('mousedown', outside);
    return () => {
      document.removeEventListener('mousedown', outside);
      // Back to the opener, unless focus already moved on (a click elsewhere).
      const lost = !document.activeElement || document.activeElement === document.body || ref.current?.contains(document.activeElement);
      if (lost && opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div
      ref={ref}
      className="chat-picker"
      role="group"
      aria-label={t('chat.react')}
      onKeyDown={(e) => {
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        const move = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
        if (move !== undefined) {
          e.preventDefault();
          items[(move + items.length) % items.length]?.focus();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
      onBlur={(e) => {
        // Tabbing out closes it.
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) onClose();
      }}
    >
      {QUICK_REACTIONS.map((e) => (
        <button key={e} type="button" className="chat-picker__item" aria-label={t('m.chat.reactWith', { emoji: e })} onClick={() => onPick(e)}>
          {e}
        </button>
      ))}
    </div>
  );
}

/** Adds one reaction to a message locally (from a realtime event or your own tap). */
export function applyReaction(m: Message, emoji: string, byMe: boolean, removed: boolean): Message {
  const list = [...(m.reactions ?? [])];
  const i = list.findIndex((r) => r.emoji === emoji);
  if (removed) {
    if (i < 0) return m;
    const r = list[i]!;
    if (r.count <= 1) list.splice(i, 1);
    else list[i] = { ...r, count: r.count - 1, mine: byMe ? false : r.mine };
  } else if (i < 0) list.push({ emoji, count: 1, mine: byMe });
  else list[i] = { ...list[i]!, count: list[i]!.count + 1, mine: byMe || list[i]!.mine };
  return { ...m, reactions: list };
}

/**
 * A line in the chat that tells everyone about a change (who changed disappearing messages), a
 * group reminder at its time, or that someone started watching together. A reminder line goes to
 * the message it's about; a watch together line joins the session while it runs.
 */
export function SystemLine({
  message,
  meId,
  onJump,
  watchSessionId,
}: {
  message: Message;
  meId?: string;
  onJump?: (id: string) => void;
  /** The watch together session running in this chat now: its line gets a Join link. */
  watchSessionId?: string | null;
}) {
  const { t, tp } = useSession();
  const who = message.sender.id === meId ? t('m.chat.you') : message.sender.displayName;
  const s = message.system;
  // "Ada added 3 songs to Road trip": several adds by one person within ten minutes share the line.
  if (s?.type === 'mix')
    return (
      <p className="chat-system" role="note">
        <Icon name="mix" size={14} />{' '}
        <Link href={`/mixes/${s.mixId}`} className="chat-system__join">
          <bdi>{tp('mixes.line', s.count, { name: who, title: s.title })}</bdi>
        </Link>
      </p>
    );
  if (s?.type === 'together') {
    // "Ada started a shared album: Lagos weekend", with a way in (people not in it see that it's not for them).
    const text =
      message.sender.id === meId
        ? t('together.chat.cardYou', { title: s.title })
        : t('together.chat.card', { name: message.sender.displayName, title: s.title });
    return (
      <p className="chat-system" role="note">
        <Icon name="image" size={14} /> <bdi>{text}</bdi>{' '}
        <Link href={`/together/${s.togetherId}`} className="chat-system__join">
          {t('together.chat.open')}
        </Link>
      </p>
    );
  }
  if (s?.type === 'watch') {
    const text = message.sender.id === meId ? t('watch.system.startedYou') : t('watch.system.started', { name: message.sender.displayName });
    return (
      <p className="chat-system" role="note">
        <Icon name="play" size={14} /> <bdi>{text}</bdi>
        {watchSessionId && watchSessionId === s.sessionId ? (
          <>
            {' '}
            <Link href={`/watch/${s.sessionId}`} className="chat-system__join">
              {t('watch.join')}
            </Link>
          </>
        ) : null}
      </p>
    );
  }
  if (s?.type === 'reminder') {
    const about = s.message;
    const text = about?.available
      ? t('m.chat.systemReminder', { name: who, text: previewText(t, about, { meId }) })
      : t('m.chat.systemReminderGone', { name: who });
    return (
      <p className="chat-system" role="note">
        {about?.available && onJump ? (
          <button type="button" className="chat-system__link" onClick={() => onJump(s.messageId)}>
            <Icon name="bell" size={14} /> <bdi>{text}</bdi>
          </button>
        ) : (
          <>
            <Icon name="bell" size={14} /> <bdi>{text}</bdi>
          </>
        )}
      </p>
    );
  }
  if (s?.type === 'game') {
    const game = t(`m.chat.game.kind.${s.kind}` as MessageKey);
    const chess = s.kind === 'chess';
    const text =
      s.outcome === 'won'
        ? t(
            s.by === 'forfeit'
              ? chess
                ? 'm.chat.systemChessResigned'
                : 'm.chat.systemGameForfeit'
              : chess
                ? 'm.chat.systemChessMate'
                : 'm.chat.systemGameWon',
            { name: who, game },
          )
        : s.outcome === 'draw'
          ? s.reason
            ? t('m.chat.systemChessDraw', { game, reason: chessDrawReason(t, s.reason) })
            : t('m.chat.systemGameDraw', { game })
          : t('m.chat.systemGameUnfinished', { game });
    return (
      <p className="chat-system" role="note">
        <Icon name="game" size={14} /> <bdi>{text}</bdi>
      </p>
    );
  }
  const text =
    s?.type === 'disappearing'
      ? s.seconds
        ? t('m.chat.systemOn', { name: who, time: disappearingLabel(t, s.seconds) })
        : t('m.chat.systemOff', { name: who })
      : s?.type === 'theme'
        ? t('m.chat.systemTheme', {
            name: who,
            wallpaper: t(`m.chat.wallpaper.${chatTheme(s).wallpaper}` as MessageKey),
            colour: t(`m.chat.accent.${chatTheme(s).accent}` as MessageKey),
          })
        : '';
  return (
    <p className="chat-system" role="note">
      <Icon name="info" size={14} /> <bdi>{text}</bdi>
    </p>
  );
}

/** Pinned messages at the top of the chat. Selecting one goes to it; with several, the next one shows. */
export function PinnedBar({
  pins,
  canManage,
  onJump,
  onUnpin,
}: {
  pins: PinnedMessage[];
  canManage: boolean;
  onJump: (id: string) => void;
  onUnpin: (id: string) => void;
}) {
  const { t, locale, me } = useSession();
  const [i, setI] = useState(0);
  if (!pins.length) return null;
  const at = Math.min(i, pins.length - 1);
  const pin = pins[at]!;
  return (
    <div className="chat-pinned" role="region" aria-label={t('chat.pinnedMessages')}>
      <Icon name="map-pin" size={16} />
      <button
        type="button"
        className="chat-pinned__main"
        onClick={() => {
          onJump(pin.message.id);
          setI((at + 1) % pins.length);
        }}
      >
        <span className="chat-pinned__label">{pins.length > 1 ? t('m.chat.pinnedOf', { n: at + 1, total: pins.length }) : t('m.chat.pinned')}</span>
        <span className="chat-pinned__text" dir="auto">
          {pin.message.sender ? <bdi>{pin.message.sender.displayName}: </bdi> : null}
          {previewText(t, pin.message, { meId: me?.id, locale })}
        </span>
      </button>
      {canManage ? (
        <button type="button" className="yp-action" aria-label={t('m.chat.unpinA11y')} onClick={() => onUnpin(pin.message.id)}>
          <Icon name="x" size={16} />
        </button>
      ) : null}
    </div>
  );
}

/** Search the messages of this chat. Selecting a result goes to it. */
export function ChatSearch({ conversationId, onJump, onClose }: { conversationId: string; onJump: (id: string) => void; onClose: () => void }) {
  const { t, tp, locale } = useSession();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Message[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Focus moves into the search, and back to what opened it (the chat's options button) when it closes.
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // Once: in development React runs this twice, and by then focus is already in the search box.
    opener.current ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    return () => {
      const back = opener.current;
      if (back?.isConnected && (document.activeElement === document.body || !document.activeElement)) back.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const text = q.trim();
    if (!text) {
      setResults(null);
      return;
    }
    const timer = setTimeout(() => {
      api.conversations.search(conversationId, text).then(
        (r) => {
          setResults(r.items);
          setCursor(r.nextCursor);
          setError(null);
        },
        (e) => setError(errorMessage(e)),
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [q, conversationId]);

  return (
    <div className="chat-search" role="search">
      <div className="row" style={{ gap: 8 }}>
        <label htmlFor="chat-search" className="yp-visually-hidden">
          {t('m.chat.search')}
        </label>
        <input
          ref={input}
          id="chat-search"
          type="search"
          className="chat-search__input"
          placeholder={t('m.chat.search')}
          value={q}
          maxLength={100}
          onChange={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <button type="button" className="yp-action" aria-label={t('chat.closeSearch')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      {/* Always present, so the number of results is announced as you type. */}
      <p className="yp-visually-hidden" role="status">
        {error ??
          (results
            ? results.length
              ? cursor
                ? t('m.chat.searchFoundMore', { count: results.length })
                : tp('m.chat.searchFound', results.length)
              : t('m.chat.searchNone')
            : '')}
      </p>
      {error ? <p className="muted">{error}</p> : null}
      {results ? (
        results.length ? (
          <ul className="chat-search__results" aria-label={t('chat.searchResults')}>
            {results.map((m) => (
              <li key={m.id}>
                <button type="button" className="chat-search__result" onClick={() => onJump(m.id)}>
                  <span className="chat-search__meta">
                    <bdi>{m.sender.displayName}</bdi> · {new Date(m.createdAt).toLocaleDateString(locale)}
                  </span>
                  <span dir="auto">{m.body}</span>
                </button>
              </li>
            ))}
            {cursor ? (
              <li>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    const r = await api.conversations.search(conversationId, q.trim(), cursor);
                    setResults((cur) => [...(cur ?? []), ...r.items]);
                    setCursor(r.nextCursor);
                  }}
                >
                  {t('chat.showMore')}
                </Button>
              </li>
            ) : null}
          </ul>
        ) : (
          <p className="muted">{t('m.chat.searchNone')}</p>
        )
      ) : null}
    </div>
  );
}

/** Choose how long new messages stay in this chat. */
export function DisappearingSheet({
  open,
  onClose,
  current,
  canChange,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  current: number | null;
  canChange: boolean;
  onChange: (seconds: number | null) => Promise<void>;
}) {
  const { t } = useSession();
  const [busy, setBusy] = useState(false);
  const options: (number | null)[] = [null, ...DISAPPEARING_SECONDS];
  return (
    <BottomSheet open={open} onClose={onClose} title={t('m.chat.disappearing')}>
      <div className="stack" style={{ gap: 12 }}>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          {t('m.chat.disappearingHint')}
        </p>
        {!canChange ? (
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            {t('m.chat.disappearingAdmins')}
          </p>
        ) : null}
        <fieldset className="chat-radio" disabled={!canChange || busy}>
          <legend className="yp-visually-hidden">{t('chat.deleteAfter')}</legend>
          {options.map((s) => (
            <label key={String(s)} className="chat-radio__option">
              <input
                type="radio"
                name="disappearing"
                checked={(current ?? null) === s}
                onChange={async () => {
                  setBusy(true);
                  try {
                    await onChange(s);
                  } finally {
                    setBusy(false);
                  }
                }}
              />
              {disappearingLabel(t, s)}
            </label>
          ))}
        </fieldset>
      </div>
    </BottomSheet>
  );
}
