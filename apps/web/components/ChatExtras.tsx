'use client';

import { useEffect, useRef, useState } from 'react';
import { BottomSheet, Button, Icon } from '@yapilapi/design-system';
import { DISAPPEARING_SECONDS, type Message, type MessagePreview, type PinnedMessage } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';

/** Quick reactions offered on every message. */
export const QUICK_REACTIONS = ['❤️', '😂', '😮', '😢', '👍', '🙏'] as const;

const DISAPPEARING_LABEL: Record<number, string> = { 86400: '24 hours', 604800: '7 days', 7776000: '90 days' };
export const disappearingLabel = (seconds: number | null | undefined) => (seconds ? (DISAPPEARING_LABEL[seconds] ?? `${seconds} seconds`) : 'Off');

/** A one-line description of a quoted message. */
export function previewText(p: MessagePreview): string {
  if (!p.available) return 'This message isn’t available.';
  if (p.unsent) return 'Message unsent';
  if (p.body) return p.body;
  switch (p.attachmentKind) {
    case 'image':
      return 'Photo';
    case 'video':
      return 'Video';
    case 'audio':
      return 'Voice message';
    default:
      return p.attachmentKind ? 'Attachment' : 'Message';
  }
}

/** The quoted original inside a reply bubble. Selecting it scrolls to the original. */
export function MessageQuote({ preview, mine, meId, onJump }: { preview: MessagePreview; mine: boolean; meId?: string; onJump: (id: string) => void }) {
  const who = !preview.available ? null : preview.sender?.id === meId ? 'You' : preview.sender?.displayName;
  return (
    <button
      type="button"
      className={`chat-quote${mine ? ' chat-quote--mine' : ''}`}
      disabled={!preview.available}
      onClick={() => onJump(preview.id)}
      aria-label={preview.available ? `Go to the message from ${who}: ${previewText(preview)}` : previewText(preview)}
    >
      {who ? <bdi className="chat-quote__who">{who}</bdi> : null}
      <span className="chat-quote__text" dir="auto">
        {previewText(preview)}
      </span>
    </button>
  );
}

/** Reaction counts under a bubble; selecting one adds or removes yours. */
export function ReactionRow({ message, mine, onToggle }: { message: Message; mine: boolean; onToggle: (emoji: string, on: boolean) => void }) {
  if (!message.reactions?.length) return null;
  return (
    <div className={`chat-reactions${mine ? ' chat-reactions--mine' : ''}`}>
      {message.reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          className={`chat-reaction${r.mine ? ' chat-reaction--mine' : ''}`}
          aria-pressed={r.mine}
          aria-label={`${r.emoji} ${r.count}. ${r.mine ? 'Remove your reaction' : 'Add this reaction'}`}
          onClick={() => onToggle(r.emoji, !r.mine)}
        >
          <span aria-hidden>{r.emoji}</span>
          <span className="chat-reaction__count">{r.count}</span>
        </button>
      ))}
    </div>
  );
}

/** The row of quick reactions, shown from a message's actions. */
export function ReactionPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('button')?.focus();
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="chat-picker"
      role="group"
      aria-label="React"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      {QUICK_REACTIONS.map((e) => (
        <button key={e} type="button" className="chat-picker__item" aria-label={`React with ${e}`} onClick={() => onPick(e)}>
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

/** The line in the chat that tells everyone who changed disappearing messages. */
export function SystemLine({ message, meId }: { message: Message; meId?: string }) {
  const who = message.sender.id === meId ? 'You' : message.sender.displayName;
  const s = message.system;
  const text =
    s?.type === 'disappearing'
      ? s.seconds
        ? `${who} turned on disappearing messages. New messages will disappear ${disappearingLabel(s.seconds)} after they’re sent.`
        : `${who} turned off disappearing messages.`
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
  const [i, setI] = useState(0);
  if (!pins.length) return null;
  const at = Math.min(i, pins.length - 1);
  const pin = pins[at]!;
  return (
    <div className="chat-pinned" role="region" aria-label="Pinned messages">
      <Icon name="map-pin" size={16} />
      <button
        type="button"
        className="chat-pinned__main"
        onClick={() => {
          onJump(pin.message.id);
          setI((at + 1) % pins.length);
        }}
      >
        <span className="chat-pinned__label">{pins.length > 1 ? `Pinned ${at + 1} of ${pins.length}` : 'Pinned'}</span>
        <span className="chat-pinned__text" dir="auto">
          {pin.message.sender ? <bdi>{pin.message.sender.displayName}: </bdi> : null}
          {previewText(pin.message)}
        </span>
      </button>
      {canManage ? (
        <button type="button" className="yp-action" aria-label="Unpin this message" onClick={() => onUnpin(pin.message.id)}>
          <Icon name="x" size={16} />
        </button>
      ) : null}
    </div>
  );
}

/** Search the messages of this chat. Selecting a result goes to it. */
export function ChatSearch({ conversationId, onJump, onClose }: { conversationId: string; onJump: (id: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Message[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

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
          Search this chat
        </label>
        <input
          ref={input}
          id="chat-search"
          type="search"
          className="chat-search__input"
          placeholder="Search this chat"
          value={q}
          maxLength={100}
          onChange={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
          }}
        />
        <button type="button" className="yp-action" aria-label="Close search" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      {error ? <p className="muted">{error}</p> : null}
      {results ? (
        results.length ? (
          <ul className="chat-search__results" aria-label="Search results">
            {results.map((m) => (
              <li key={m.id}>
                <button type="button" className="chat-search__result" onClick={() => onJump(m.id)}>
                  <span className="chat-search__meta">
                    <bdi>{m.sender.displayName}</bdi> · {new Date(m.createdAt).toLocaleDateString()}
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
                  Show more
                </Button>
              </li>
            ) : null}
          </ul>
        ) : (
          <p className="muted" role="status">
            No messages match.
          </p>
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
  const [busy, setBusy] = useState(false);
  const options: (number | null)[] = [null, ...DISAPPEARING_SECONDS];
  return (
    <BottomSheet open={open} onClose={onClose} title="Disappearing messages">
      <div className="stack" style={{ gap: 12 }}>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          When this is on, new messages in this chat are deleted for everyone after the time you choose. Messages sent before you change it aren’t affected.
          Everyone here sees who changed it.
        </p>
        {!canChange ? (
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            Only group admins can change this.
          </p>
        ) : null}
        <fieldset className="chat-radio" disabled={!canChange || busy}>
          <legend className="yp-visually-hidden">Delete new messages after</legend>
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
              {disappearingLabel(s)}
            </label>
          ))}
        </fieldset>
      </div>
    </BottomSheet>
  );
}
