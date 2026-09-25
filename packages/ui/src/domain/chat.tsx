import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Avatar } from '../components/avatar';
import { Button, IconButton } from '../components/primitives';
import { Menu, type MenuItemDef } from '../components/menu';
import { CloseIcon, CommentIcon, MoreIcon, TrashIcon, LockIcon } from '../components/icons';
import { useUI } from '../context';
import { formatDate, formatDateTime, formatRelativeTime, formatTime } from '../format';
import { cx } from '../utils';
import type { ReactionType } from './types';

const REACTION_ORDER: ReactionType[] = ['like', 'love', 'laugh', 'wow', 'sad', 'insightful'];
const EMOJI: Record<ReactionType, string> = {
  like: '👍',
  love: '❤️',
  laugh: '😄',
  wow: '😮',
  sad: '😢',
  insightful: '💡',
};

// ------------------------------------------------------------------ data shapes
export interface ChatPerson {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface ChatMessageData {
  /** Server id, or the client id while a message is still being sent. */
  id: string;
  senderId: string | null;
  sender: ChatPerson | null;
  kind: string;
  body: string;
  deleted: boolean;
  replyTo: { id: string; senderId: string | null; body: string; deleted: boolean } | null;
  reactions: { counts: Partial<Record<ReactionType, number>>; mine: ReactionType | null };
  createdAt: string;
  editedAt: string | null;
}

export type ChatMessageStatus = 'sending' | 'failed' | 'sent';

export interface ChatItem {
  message: ChatMessageData;
  status: ChatMessageStatus;
}

// ------------------------------------------------------------------ conversation row
export interface ConversationRowLabels {
  unread: (n: number) => string;
  muted: string;
  pinned: string;
  noMessages: string;
}

export interface ConversationRowProps {
  title: string;
  avatarName: string;
  avatarSrc?: string | null;
  href: string;
  preview: string | null;
  /** Prefix such as "You" when the last message was sent by the viewer. */
  previewPrefix?: string | null;
  time: string | null;
  unread: number;
  muted: boolean;
  pinned: boolean;
  current?: boolean;
  labels: ConversationRowLabels;
  now?: number;
}

export function ConversationRow({
  title,
  avatarName,
  avatarSrc,
  href,
  preview,
  previewPrefix,
  time,
  unread,
  muted,
  pinned,
  current,
  labels,
  now,
}: ConversationRowProps) {
  const { Link, locale } = useUI();
  const previewText = preview
    ? previewPrefix
      ? `${previewPrefix}: ${preview}`
      : preview
    : labels.noMessages;
  return (
    <Link
      href={href}
      className={cx('yl-convrow', unread > 0 && 'yl-convrow--unread', current && 'is-current')}
      {...(current ? { 'aria-current': 'page' as const } : {})}
    >
      <Avatar name={avatarName} src={avatarSrc} decorative />
      <span className="yl-convrow__main">
        <span className="yl-convrow__top">
          <span className="yl-convrow__title">{title}</span>
          {time ? (
            <time className="yl-convrow__time" dateTime={time} title={formatDateTime(time, locale)}>
              {formatRelativeTime(time, locale, now)}
            </time>
          ) : null}
        </span>
        <span className="yl-convrow__bottom">
          <span className="yl-convrow__preview">{previewText}</span>
          {pinned ? (
            <span className="yl-convrow__flag" title={labels.pinned}>
              <span aria-hidden="true">📌</span>
              <span className="yl-sr-only">{labels.pinned}</span>
            </span>
          ) : null}
          {muted ? (
            <span className="yl-convrow__flag" title={labels.muted}>
              <span aria-hidden="true">🔕</span>
              <span className="yl-sr-only">{labels.muted}</span>
            </span>
          ) : null}
          {unread > 0 ? (
            <span className="yl-convrow__badge">
              {unread >= 100 ? '99+' : unread}
              <span className="yl-sr-only"> {labels.unread(unread)}</span>
            </span>
          ) : null}
        </span>
      </span>
    </Link>
  );
}

// ------------------------------------------------------------------ message bubble
export interface MessageBubbleLabels {
  you: string;
  deleted: string;
  reply: string;
  react: string;
  options: string;
  delete: string;
  edited: string;
  sending: string;
  failed: string;
  retry: string;
  discard: string;
  reactionCount: (kind: string, n: number) => string;
  reactions: Record<ReactionType, string>;
  replyingTo: (name: string) => string;
  originalDeleted: string;
  sentAt: (name: string, when: string) => string;
}

export interface MessageBubbleProps {
  item: ChatItem;
  mine: boolean;
  /** Show the sender's name and avatar (group chats, first message of a run). */
  showSender: boolean;
  /** Display name of whoever the replied-to message was sent by. */
  replyAuthorName?: string | null;
  labels: MessageBubbleLabels;
  onReact?: (message: ChatMessageData, kind: ReactionType | null) => void | Promise<void>;
  onReply?: (message: ChatMessageData) => void;
  onDelete?: (message: ChatMessageData) => void | Promise<void>;
  onRetry?: (message: ChatMessageData) => void;
  onDiscard?: (message: ChatMessageData) => void;
  onJumpTo?: (messageId: string) => void;
  canInteract?: boolean;
}

export function MessageBubble({
  item,
  mine,
  showSender,
  replyAuthorName,
  labels,
  onReact,
  onReply,
  onDelete,
  onRetry,
  onDiscard,
  onJumpTo,
  canInteract = true,
}: MessageBubbleProps) {
  const { message, status } = item;
  const { Link, locale } = useUI();
  const name = message.sender?.displayName ?? '';
  const pending = status === 'sending';
  const failed = status === 'failed';
  const counts = REACTION_ORDER.filter((k) => (message.reactions.counts[k] ?? 0) > 0);
  const who = mine ? labels.you : name;

  const react = (k: ReactionType) =>
    void onReact?.(message, message.reactions.mine === k ? null : k);

  const menuItems: MenuItemDef[] = [];
  if (mine && !message.deleted && onDelete) {
    menuItems.push({
      id: 'delete',
      label: labels.delete,
      icon: <TrashIcon size={16} />,
      danger: true,
      onSelect: () => void onDelete(message),
    });
  }
  const showTools = canInteract && !message.deleted && !pending && !failed;

  return (
    <div
      className={cx(
        'yl-msg',
        mine && 'yl-msg--mine',
        pending && 'is-pending',
        failed && 'is-failed',
        message.deleted && 'is-deleted',
      )}
      data-message-id={message.id}
    >
      {!mine ? (
        showSender && message.sender ? (
          <Link
            href={`/u/${message.sender.username}`}
            tabIndex={-1}
            className="yl-msg__avatar"
            aria-hidden="true"
          >
            <Avatar name={name} src={message.sender.avatarUrl} size="sm" decorative />
          </Link>
        ) : (
          <span className="yl-msg__avatar yl-msg__avatar--gap" aria-hidden="true" />
        )
      ) : null}
      <div className="yl-msg__col">
        {showSender && !mine && message.sender ? (
          <Link href={`/u/${message.sender.username}`} className="yl-msg__sender">
            {name}
          </Link>
        ) : null}
        <div className="yl-msg__bubble-row">
          <div className="yl-msg__bubble">
            {message.replyTo ? (
              <button
                type="button"
                className="yl-msg__quote"
                onClick={() => onJumpTo?.(message.replyTo!.id)}
                disabled={!onJumpTo}
              >
                <span className="yl-msg__quote-name">
                  {labels.replyingTo(replyAuthorName ?? '')}
                </span>
                <span className="yl-msg__quote-body">
                  {message.replyTo.deleted ? labels.originalDeleted : message.replyTo.body}
                </span>
              </button>
            ) : null}
            {message.deleted ? (
              <p className="yl-msg__body yl-msg__body--deleted">{labels.deleted}</p>
            ) : (
              <p className="yl-msg__body">{message.body}</p>
            )}
            <p className="yl-msg__meta">
              <time dateTime={message.createdAt} title={formatDateTime(message.createdAt, locale)}>
                {formatTime(message.createdAt, locale)}
              </time>
              {message.editedAt && !message.deleted ? <span> · {labels.edited}</span> : null}
              {pending ? <span> · {labels.sending}</span> : null}
            </p>
          </div>
          {showTools ? (
            <div className="yl-msg__tools">
              <Menu
                label={labels.react}
                align={mine ? 'end' : 'start'}
                trigger={
                  <button
                    type="button"
                    className="yl-iconbtn yl-iconbtn--ghost yl-iconbtn--sm"
                    aria-label={labels.react}
                    title={labels.react}
                  >
                    <span aria-hidden="true">☺</span>
                  </button>
                }
                items={REACTION_ORDER.map((k) => ({
                  id: k,
                  label: labels.reactions[k],
                  icon: <span aria-hidden="true">{EMOJI[k]}</span>,
                  checked: message.reactions.mine === k,
                  onSelect: () => react(k),
                }))}
              />
              {onReply ? (
                <IconButton
                  label={labels.reply}
                  icon={<CommentIcon size={16} />}
                  size="sm"
                  onClick={() => onReply(message)}
                />
              ) : null}
              {menuItems.length ? (
                <Menu
                  label={labels.options}
                  align={mine ? 'end' : 'start'}
                  trigger={
                    <IconButton label={labels.options} icon={<MoreIcon size={16} />} size="sm" />
                  }
                  items={menuItems}
                />
              ) : null}
            </div>
          ) : null}
        </div>
        {counts.length > 0 ? (
          <ul className="yl-msg__reactions">
            {counts.map((k) => (
              <li key={k}>
                <button
                  type="button"
                  className={cx('yl-reactchip', message.reactions.mine === k && 'is-mine')}
                  aria-pressed={message.reactions.mine === k}
                  aria-label={labels.reactionCount(
                    labels.reactions[k],
                    message.reactions.counts[k] ?? 0,
                  )}
                  disabled={!canInteract}
                  onClick={() => react(k)}
                >
                  <span aria-hidden="true">{EMOJI[k]}</span>
                  <span aria-hidden="true">{message.reactions.counts[k]}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {failed ? (
          <p className="yl-msg__failed" role="alert">
            <span>{labels.failed}</span>
            {onRetry ? (
              <Button size="sm" variant="ghost" onClick={() => onRetry(message)}>
                {labels.retry}
              </Button>
            ) : null}
            {onDiscard ? (
              <Button size="sm" variant="ghost" onClick={() => onDiscard(message)}>
                {labels.discard}
              </Button>
            ) : null}
          </p>
        ) : null}
        <span className="yl-sr-only">
          {labels.sentAt(who, formatDateTime(message.createdAt, locale))}
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ message list
export interface MessageListLabels {
  log: string;
  empty: string;
  loadOlder: string;
  loadingOlder: string;
  newMessages: string;
  today: string;
  yesterday: string;
}

export interface MessageListProps {
  items: ChatItem[];
  viewerId: string;
  /** Show sender names (group and channel chats). */
  showSenders: boolean;
  labels: MessageListLabels;
  bubbleLabels: MessageBubbleLabels;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadOlder?: () => void;
  /** Resolves a person's display name for reply quotes. */
  nameOf?: (userId: string | null) => string | null;
  onReact?: MessageBubbleProps['onReact'];
  onReply?: MessageBubbleProps['onReply'];
  onDelete?: MessageBubbleProps['onDelete'];
  onRetry?: MessageBubbleProps['onRetry'];
  onDiscard?: MessageBubbleProps['onDiscard'];
  canInteract?: boolean;
  /** Extra content rendered after the last message (e.g. a "Seen" line or typing indicator). */
  footer?: ReactNode;
  now?: number;
}

const dayKey = (iso: string): string => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

const NEAR_BOTTOM = 96;

type Row =
  | { type: 'day'; key: string; iso: string }
  | { type: 'msg'; key: string; item: ChatItem; showSender: boolean };

/**
 * A live `log` region. It sticks to the bottom while the reader is at the bottom, otherwise it leaves the scroll
 * position alone and offers a "new messages" button. The scroll area itself is focusable so keyboard users can scroll.
 */
export function MessageList(props: MessageListProps) {
  const {
    items,
    viewerId,
    showSenders,
    labels,
    bubbleLabels,
    hasMore,
    loadingMore,
    onLoadOlder,
    nameOf,
    footer,
    now,
    onReact,
    onReply,
    onDelete,
    onRetry,
    onDiscard,
    canInteract,
  } = props;
  const { locale } = useUI();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const prevLast = useRef<string | null>(null);
  const prevFirst = useRef<string | null>(null);
  const prevHeight = useRef(0);
  const [showNew, setShowNew] = useState(false);

  const rows = useMemo(() => {
    const out: Row[] = [];
    let lastDay = '';
    let lastSender: string | null | undefined;
    for (const item of items) {
      const dk = dayKey(item.message.createdAt);
      if (dk !== lastDay) {
        out.push({ type: 'day', key: `day-${dk}`, iso: item.message.createdAt });
        lastDay = dk;
        lastSender = undefined;
      }
      out.push({
        type: 'msg',
        key: item.message.id,
        item,
        showSender: showSenders && item.message.senderId !== lastSender,
      });
      lastSender = item.message.senderId;
    }
    return out;
  }, [items, showSenders]);

  const scrollToEnd = (smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    if (typeof el.scrollTo === 'function')
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    else el.scrollTop = el.scrollHeight;
  };

  // After each render: keep the bottom pinned, or preserve position when older messages were prepended.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const first = items[0]?.message.id ?? null;
    const last = items[items.length - 1]?.message.id ?? null;
    const prepended =
      prevFirst.current !== null && first !== prevFirst.current && last === prevLast.current;
    if (prepended) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (last !== prevLast.current) {
      const mineNew = items[items.length - 1]?.message.senderId === viewerId;
      if (stickRef.current || mineNew || prevLast.current === null) {
        scrollToEnd(false);
        setShowNew(false);
      } else {
        setShowNew(true);
      }
    }
    prevFirst.current = first;
    prevLast.current = last;
    prevHeight.current = el.scrollHeight;
  }, [items, viewerId]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM;
    stickRef.current = near;
    if (near) setShowNew(false);
  };

  const jumpTo = (id: string) => {
    const target = scrollRef.current?.querySelector<HTMLElement>(
      `[data-message-id="${id.replace(/"/g, '')}"]`,
    );
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    target.classList.add('is-flash');
    window.setTimeout(() => target.classList.remove('is-flash'), 1600);
  };

  const dayLabel = (iso: string): string => {
    const d = new Date(iso);
    const ref = new Date(now ?? Date.now());
    const same = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
    if (same(d, ref)) return labels.today;
    const y = new Date(ref);
    y.setDate(y.getDate() - 1);
    if (same(d, y)) return labels.yesterday;
    return formatDate(d, locale, { dateStyle: 'medium' });
  };

  return (
    <div className="yl-msglist">
      <div
        ref={scrollRef}
        className="yl-msglist__scroll"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={labels.log}
        tabIndex={0}
        onScroll={onScroll}
      >
        {hasMore ? (
          <div className="yl-msglist__older">
            <Button
              variant="secondary"
              size="sm"
              onClick={onLoadOlder}
              loading={loadingMore ?? false}
              loadingLabel={labels.loadingOlder}
            >
              {labels.loadOlder}
            </Button>
          </div>
        ) : null}
        {items.length === 0 ? <p className="yl-msglist__empty">{labels.empty}</p> : null}
        <ol className="yl-msglist__list">
          {rows.map((r) =>
            r.type === 'day' ? (
              <li key={r.key} className="yl-msglist__day">
                <span>{dayLabel(r.iso)}</span>
              </li>
            ) : (
              <li key={r.key} className={cx('yl-msglist__item', r.showSender && 'is-run-start')}>
                <MessageBubble
                  item={r.item}
                  mine={r.item.message.senderId === viewerId}
                  showSender={r.showSender}
                  replyAuthorName={
                    r.item.message.replyTo
                      ? (nameOf?.(r.item.message.replyTo.senderId) ?? null)
                      : null
                  }
                  labels={bubbleLabels}
                  onJumpTo={jumpTo}
                  {...(onReact ? { onReact } : {})}
                  {...(onReply ? { onReply } : {})}
                  {...(onDelete ? { onDelete } : {})}
                  {...(onRetry ? { onRetry } : {})}
                  {...(onDiscard ? { onDiscard } : {})}
                  {...(canInteract !== undefined ? { canInteract } : {})}
                />
              </li>
            ),
          )}
        </ol>
        {footer}
      </div>
      {showNew ? (
        <button
          type="button"
          className="yl-msglist__new"
          onClick={() => {
            scrollToEnd(true);
            setShowNew(false);
          }}
        >
          {labels.newMessages}
        </button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ composer
export interface ChatComposerLabels {
  label: string;
  placeholder: string;
  send: string;
  hint: string;
  replyingTo: (name: string) => string;
  cancelReply: string;
  tooLong: string;
}

export interface ChatComposerProps {
  labels: ChatComposerLabels;
  onSend: (body: string) => void | Promise<void>;
  /** Called with true when the person starts typing and false once they stop. */
  onTyping?: (typing: boolean) => void;
  replyTo?: { name: string; body: string } | null;
  onCancelReply?: () => void;
  /** When set, the composer is replaced by this explanation (e.g. "you cannot send messages here"). */
  disabledReason?: string | null;
  maxLength?: number;
}

export function ChatComposer({
  labels,
  onSend,
  onTyping,
  replyTo,
  onCancelReply,
  disabledReason,
  maxLength = 4000,
}: ChatComposerProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const typingRef = useRef(false);
  const stopTimer = useRef<number | null>(null);
  const lastSent = useRef(0);
  const id = useId();

  useEffect(
    () => () => {
      if (stopTimer.current) window.clearTimeout(stopTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (replyTo) ref.current?.focus();
  }, [replyTo]);

  const setTyping = (v: boolean) => {
    if (typingRef.current === v) return;
    typingRef.current = v;
    lastSent.current = Date.now();
    onTyping?.(v);
  };

  const change = (value: string) => {
    setText(value);
    setError(null);
    if (value.trim()) {
      // Repeat the "typing" signal while the person keeps typing so the other side's indicator does not lapse.
      if (typingRef.current && Date.now() - lastSent.current > 2500) {
        lastSent.current = Date.now();
        onTyping?.(true);
      }
      setTyping(true);
      if (stopTimer.current) window.clearTimeout(stopTimer.current);
      stopTimer.current = window.setTimeout(() => setTyping(false), 3000);
    } else {
      setTyping(false);
    }
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body) return;
    if (body.length > maxLength) {
      setError(labels.tooLong);
      return;
    }
    setText('');
    setTyping(false);
    void onSend(body);
    ref.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape' && replyTo) onCancelReply?.();
  };

  if (disabledReason) {
    return (
      <p className="yl-chatcomposer yl-chatcomposer--blocked" role="note">
        <LockIcon size={16} /> {disabledReason}
      </p>
    );
  }

  return (
    <form className="yl-chatcomposer" onSubmit={submit}>
      {replyTo ? (
        <div className="yl-chatcomposer__reply">
          <div className="yl-chatcomposer__reply-text">
            <strong>{labels.replyingTo(replyTo.name)}</strong>
            <span>{replyTo.body}</span>
          </div>
          <IconButton
            label={labels.cancelReply}
            icon={<CloseIcon size={16} />}
            size="sm"
            onClick={onCancelReply}
          />
        </div>
      ) : null}
      <div className="yl-chatcomposer__row">
        <label htmlFor={`${id}-t`} className="yl-sr-only">
          {labels.label}
        </label>
        <textarea
          id={`${id}-t`}
          ref={ref}
          className="yl-chatcomposer__input"
          rows={1}
          value={text}
          placeholder={labels.placeholder}
          aria-describedby={`${id}-h`}
          aria-invalid={error ? true : undefined}
          onChange={(e) => change(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => setTyping(false)}
          enterKeyHint="send"
        />
        <Button type="submit" variant="primary" disabled={!text.trim()}>
          {labels.send}
        </Button>
      </div>
      <p
        id={`${id}-h`}
        className={cx('yl-chatcomposer__hint', error && 'is-error')}
        role={error ? 'alert' : undefined}
      >
        {error ?? labels.hint}
      </p>
    </form>
  );
}
