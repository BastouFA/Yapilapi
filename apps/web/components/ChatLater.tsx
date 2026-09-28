'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Alert, BottomSheet, Button, Icon, TextField } from '@yapilapi/design-system';
import {
  ACCENTS,
  CHAT_ACCENTS,
  CHAT_WALLPAPERS,
  chatTheme,
  quickChoices,
  sameDay,
  SCHEDULED_MESSAGE_MAX_DAYS,
  WALLPAPERS,
  type ChatAccent,
  type ChatTheme,
  type ChatWallpaper,
  type MessageKey,
  type ScheduledMessage,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { localInput } from '@/lib/schedule';
import { useRealtime, useSession, type Session } from '@/app/providers';

/**
 * Chats: "Send later" (a clock next to Send; the messages waiting show only to you, at the
 * bottom of the chat, with Edit, Send now and Cancel) and the chat's wallpaper and bubble colour.
 */

const QUICK: Record<string, MessageKey> = { hour: 'm.picker.inHour', tonight: 'm.picker.tonight', morning: 'm.picker.tomorrowMorning' };

/** "Sends at 20:00" today, "Sends Sat 4 Oct at 20:00" another day. */
export function sendsLabel(t: Session['t'], locale: string, iso: string): string {
  const at = new Date(iso);
  const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(at);
  if (sameDay(at, new Date())) return t('m.chat.later.sendsAt', { time });
  const date = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}),
  }).format(at);
  return t('m.chat.later.sendsOn', { date, time });
}

/** Your messages waiting to be sent in this chat, kept current across your devices. */
export function useScheduled(conversationId: string) {
  const [items, setItems] = useState<ScheduledMessage[]>([]);
  const load = useCallback(
    () =>
      api.conversations.scheduled(conversationId).then(
        (r) => setItems(r.items),
        () => {},
      ),
    [conversationId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useRealtime((e) => {
    if (e.type === 'scheduled.updated' && e.data?.conversationId === conversationId) void load();
  });
  return { items, setItems, reload: load };
}

/**
 * Pick when to send (new message), or change a waiting one's text and time (`editing`). The
 * time is in your time zone, from a minute to a year ahead.
 */
export function ScheduleSheet({
  open,
  onClose,
  conversationId,
  body,
  replyToId,
  editing,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  /** The text in the message box, for a new one. */
  body?: string;
  replyToId?: string;
  editing?: ScheduledMessage | null;
  onDone: (s: ScheduledMessage) => void;
}) {
  const { t, toast } = useSession();
  const [at, setAt] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setText(editing?.body ?? body ?? '');
    const start = editing && editing.status === 'scheduled' ? new Date(editing.sendAt) : new Date(Date.now() + 60 * 60_000);
    setAt(localInput(start));
  }, [open, editing, body]);
  if (!open) return null;
  const now = new Date();
  const min = new Date(now.getTime() + 2 * 60_000);
  const max = new Date(now.getTime() + SCHEDULED_MESSAGE_MAX_DAYS * 86_400_000);
  const quick = quickChoices(now).filter((q) => q.at > min && q.at < max);

  async function save(date: Date) {
    const message = text.trim();
    if (!message) return setError(t('m.chat.editEmpty'));
    setBusy(true);
    setError(null);
    try {
      const r = editing
        ? await api.scheduledMessages.edit(editing.id, { body: message, sendAt: date.toISOString() })
        : await api.conversations.schedule(conversationId, { body: message, sendAt: date.toISOString(), ...(replyToId ? { replyToId } : {}) });
      onDone(r.scheduled);
      if (!editing) toast(t('m.chat.later.done'));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet open onClose={onClose} title={editing ? t('m.chat.later.editTitle') : t('m.chat.later.title')}>
      <form
        className="stack"
        style={{ gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (at) void save(new Date(at));
        }}
      >
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          {t('m.chat.later.hint')}
        </p>
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <TextField label={t('m.chat.later.text')} multiline rows={3} value={text} maxLength={4000} onChange={(e) => setText(e.currentTarget.value)} required />
        {quick.length ? (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }} role="group" aria-label={t('m.picker.shortcuts')}>
            {quick.map((q) => (
              <Button key={q.id} size="sm" variant="secondary" disabled={busy || !text.trim()} onClick={() => void save(q.at)}>
                {t(QUICK[q.id]!)}
              </Button>
            ))}
          </div>
        ) : null}
        <TextField
          label={editing?.status === 'failed' ? t('m.chat.later.newTime') : t('m.chat.later.when')}
          type="datetime-local"
          value={at}
          min={localInput(min)}
          max={localInput(max)}
          onChange={(e) => setAt(e.currentTarget.value)}
          required
        />
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" icon="clock" loading={busy} disabled={!at || !text.trim()}>
            {editing ? t('m.chat.later.save') : t('m.chat.later.schedule')}
          </Button>
        </div>
      </form>
    </BottomSheet>
  );
}

/**
 * The messages waiting to be sent, at the end of the chat on your side, faded, each with
 * "Sends at 20:00 · Edit · Send now · Cancel". One that couldn't be sent says why.
 */
export function ScheduledList({
  items,
  onEdit,
  onSent,
  onRemoved,
}: {
  items: ScheduledMessage[];
  onEdit: (s: ScheduledMessage) => void;
  onSent: (s: ScheduledMessage, message: import('@yapilapi/shared').Message) => void;
  onRemoved: (s: ScheduledMessage) => void;
}) {
  const { t, locale, toast } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  if (!items.length) return null;
  // While one is being sent or cancelled its buttons stay focusable (aria-disabled), so focus isn't lost if it fails.
  const run = async (s: ScheduledMessage, action: () => Promise<void>) => {
    if (busy === s.id) return;
    setBusy(s.id);
    try {
      await action();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="chat-later" aria-label={t('m.chat.later.list')}>
      {items.map((s) => (
        <div key={s.id} className={`chat-later__item${s.status === 'failed' ? ' chat-later__item--failed' : ''}`}>
          {/* The buttons below are described by the message and its time, so "Cancel" says which one. */}
          <div id={`later-${s.id}`} className="yp-bubble yp-bubble--me chat-later__bubble" dir="auto">
            {s.body}
          </div>
          <p className="chat-later__meta">
            <Icon name={s.status === 'failed' ? 'alert' : 'clock'} size={14} />
            <span id={`later-${s.id}-when`}>
              {s.status === 'failed' ? t('m.chat.later.failed', { reason: s.failure ?? '' }) : sendsLabel(t, locale, s.sendAt)}
            </span>
            <span aria-hidden>·</span>
            <button
              type="button"
              className="chat-later__action"
              aria-disabled={busy === s.id || undefined}
              aria-describedby={`later-${s.id} later-${s.id}-when`}
              onClick={() => busy !== s.id && onEdit(s)}
            >
              {s.status === 'failed' ? t('m.chat.later.newTime') : t('m.chat.later.edit')}
            </button>
            <span aria-hidden>·</span>
            <button
              type="button"
              className="chat-later__action"
              aria-disabled={busy === s.id || undefined}
              aria-describedby={`later-${s.id} later-${s.id}-when`}
              onClick={() =>
                void run(s, async () => {
                  const { message } = await api.scheduledMessages.sendNow(s.id);
                  onSent(s, message);
                })
              }
            >
              {t('m.chat.later.sendNow')}
            </button>
            <span aria-hidden>·</span>
            <button
              type="button"
              className="chat-later__action"
              aria-disabled={busy === s.id || undefined}
              aria-describedby={`later-${s.id} later-${s.id}-when`}
              onClick={() => {
                if (busy === s.id || (s.status === 'scheduled' && !confirm(t('m.chat.later.cancelConfirm')))) return;
                void run(s, async () => {
                  await api.scheduledMessages.cancel(s.id);
                  onRemoved(s);
                });
              }}
            >
              {s.status === 'failed' ? t('m.chat.later.dismiss') : t('m.chat.later.cancel')}
            </button>
          </p>
        </div>
      ))}
    </section>
  );
}

// ─── Wallpaper and bubble colour ────────────────────────────────────────

/**
 * The chat's colours as CSS variables, light and dark both: globals.css picks the pair for the
 * appearance in use (.chat-themed), so the chat follows the app's light or dark mode.
 */
export function chatThemeVars(theme: ChatTheme | undefined): CSSProperties {
  const th = chatTheme(theme);
  const w = WALLPAPERS[th.wallpaper];
  const a = ACCENTS[th.accent];
  return {
    '--cw-from-l': w.light.from,
    '--cw-to-l': w.light.to,
    '--cw-mark-l': w.light.mark ?? 'transparent',
    '--cw-from-d': w.dark.from,
    '--cw-to-d': w.dark.to,
    '--cw-mark-d': w.dark.mark ?? 'transparent',
    '--ca-from-l': a.light.from,
    '--ca-to-l': a.light.to,
    '--ca-on-l': a.light.on,
    '--ca-from-d': a.dark.from,
    '--ca-to-d': a.dark.to,
    '--ca-on-d': a.dark.on,
  } as CSSProperties;
}

/** Class names for a chat's look: the wallpaper's kind and pattern, and whether the bubble colour is the brand one. */
export function chatThemeClass(theme: ChatTheme | undefined): string {
  const th = chatTheme(theme);
  const spec = WALLPAPERS[th.wallpaper];
  return [
    'chat-themed',
    spec.kind !== 'plain' ? `chat-wall chat-wall--${spec.kind === 'pattern' ? spec.pattern : 'gradient'}` : '',
    th.accent !== 'yapi' ? 'chat-accent' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Pick the chat's wallpaper and bubble colour, with a preview. Changes apply for everyone right away. */
export function ChatLookSheet({
  open,
  onClose,
  theme,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  theme: ChatTheme | undefined;
  onPick: (next: Partial<ChatTheme>) => Promise<void>;
}) {
  const { t } = useSession();
  const [busy, setBusy] = useState(false);
  const current = chatTheme(theme);
  const pick = async (next: Partial<ChatTheme>) => {
    setBusy(true);
    try {
      await onPick(next);
    } finally {
      setBusy(false);
    }
  };
  return (
    <BottomSheet open={open} onClose={onClose} title={t('m.chat.look.title')}>
      <div className="stack" style={{ gap: 16 }}>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          {t('m.chat.look.desc')}
        </p>
        <div className={`chat-look__preview ${chatThemeClass(current)}`} style={chatThemeVars(current)} aria-label={t('m.chat.look.preview')} role="img">
          <div className="yp-bubble yp-bubble--them">{t('m.chat.look.sampleThem')}</div>
          <div className="chat-msg--mine" style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <div className="yp-bubble yp-bubble--me">{t('m.chat.look.sampleMe')}</div>
          </div>
        </div>
        {/* Toggle buttons in a fieldset, not radios: each change posts a line in the chat, so arrow keys must not pick.
            They stay focusable (aria-disabled) while a change is saved, so focus isn't lost. */}
        <fieldset className="chat-look__group">
          <legend>{t('m.chat.look.wallpaper')}</legend>
          <div className="chat-look__grid">
            {CHAT_WALLPAPERS.map((w: ChatWallpaper) => (
              <button
                key={w}
                type="button"
                aria-pressed={current.wallpaper === w}
                aria-disabled={busy || undefined}
                className="chat-look__swatch"
                onClick={() => !busy && current.wallpaper !== w && void pick({ wallpaper: w })}
              >
                <span
                  className={`chat-look__sample ${chatThemeClass({ wallpaper: w, accent: current.accent })}`}
                  style={chatThemeVars({ wallpaper: w, accent: current.accent })}
                />
                <span>{t(`m.chat.wallpaper.${w}` as MessageKey)}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="chat-look__group">
          <legend>{t('m.chat.look.colour')}</legend>
          <div className="chat-look__grid">
            {CHAT_ACCENTS.map((a: ChatAccent) => (
              <button
                key={a}
                type="button"
                aria-pressed={current.accent === a}
                aria-disabled={busy || undefined}
                className="chat-look__swatch"
                onClick={() => !busy && current.accent !== a && void pick({ accent: a })}
              >
                <span className="chat-look__dot chat-themed chat-accent" style={chatThemeVars({ wallpaper: current.wallpaper, accent: a })} />
                <span>{t(`m.chat.accent.${a}` as MessageKey)}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>
            {t('m.common.close')}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}
