'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { BottomSheet, Button, Checkbox, Icon, TextField } from '@yapilapi/design-system';
import {
  CHAT_LIST_ITEM_MAX,
  CHAT_LIST_MAX_ITEMS,
  CHAT_LIST_TITLE_MAX,
  CHAT_POLL_MAX_DAYS,
  CHAT_POLL_MAX_OPTIONS,
  CHAT_POLL_MIN_OPTIONS,
  CHAT_POLL_OPTION_MAX,
  CHAT_POLL_QUESTION_MAX,
  CHAT_REMINDER_MAX_DAYS,
  quickChoices,
  type ChatList,
  type ChatPoll,
  type ChatReminder,
  type Message,
  type MessageKey,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { localInput } from '@/lib/schedule';
import { useSession } from '@/app/providers';

/**
 * Polls, shared lists and reminders in a chat (web). A poll is a group of radio buttons (or
 * checkboxes when several choices are allowed) that vote as soon as you pick; a list is a set of
 * checkboxes with move and remove buttons. Results and progress sit in polite live regions, so
 * changes from other people are read out without moving focus.
 */

const QUICK: Record<string, MessageKey> = { hour: 'm.picker.inHour', tonight: 'm.picker.tonight', morning: 'm.picker.tomorrowMorning' };

/** "Tomorrow, 09:00" in the reader's language. */
function when(iso: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

// ─── Poll in a message ──────────────────────────────────────────────────

export function PollView({ message, meId, mine, onPoll }: { message: Message; meId?: string; mine: boolean; onPoll: (poll: ChatPoll) => void }) {
  const { t, tp, locale, toast } = useSession();
  const poll = message.poll!;
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const legendId = useId();
  const creator = poll.createdBy === meId;
  const canAdd = !poll.ended && (poll.allowAddOptions || creator) && poll.options.length < CHAT_POLL_MAX_OPTIONS;
  const voted = poll.options.some((o) => o.mine);

  async function run(action: () => Promise<{ poll: ChatPoll | null }>) {
    setBusy(true);
    try {
      const r = await action();
      if (r.poll) onPoll(r.poll);
      return true;
    } catch (e) {
      toast(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const choose = (optionId: string, on: boolean) => {
    if (busy) return;
    const current = poll.options.filter((o) => o.mine).map((o) => o.id);
    const next = poll.multiple ? (on ? [...current, optionId] : current.filter((x) => x !== optionId)) : on ? [optionId] : [];
    void run(() => api.messages.vote(message.id, next));
  };

  const name = (u: { id: string; displayName: string }) => (u.id === meId ? t('m.chat.you') : u.displayName);
  const status = [
    tp('m.chat.poll.voters', poll.voterCount),
    poll.ended ? t('m.chat.poll.ended') : poll.endsAt ? t('m.chat.poll.ends', { time: when(poll.endsAt, locale) }) : null,
    poll.anonymous ? t('m.chat.poll.anonymousNote') : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={`chat-poll${mine ? ' chat-poll--mine' : ''}`}>
      {/* Not disabled while a vote is saving: that would take focus away from the option you picked. */}
      <fieldset className="chat-poll__set" disabled={poll.ended} aria-busy={busy} aria-describedby={`${legendId}-status`}>
        <legend className="chat-poll__question" id={legendId}>
          <span className="chat-poll__label">
            <Icon name="poll" size={14} /> {t('m.chat.poll.label')}
          </span>
          <span dir="auto">{poll.question}</span>
          <span className="chat-poll__hint">{poll.multiple ? t('m.chat.poll.pickMany') : t('m.chat.poll.pickOne')}</span>
        </legend>
        {poll.options.map((o) => {
          const percent = poll.voterCount ? Math.round((o.votes / poll.voterCount) * 100) : 0;
          const votersId = `${legendId}-${o.id}-voters`;
          return (
            <div key={o.id} className={`chat-poll__option${o.mine ? ' chat-poll__option--mine' : ''}`}>
              <label className="chat-poll__choice">
                <input
                  type={poll.multiple ? 'checkbox' : 'radio'}
                  name={`poll-${message.id}`}
                  checked={o.mine}
                  aria-describedby={o.voters?.length ? votersId : undefined}
                  onChange={(e) => choose(o.id, e.currentTarget.checked)}
                />
                <span className="chat-poll__text" dir="auto">
                  {o.text}
                </span>
                <span className="chat-poll__count">
                  {percent}%<span className="yp-visually-hidden">, {tp('m.poll.votes', o.votes)}</span>
                </span>
              </label>
              <span className="chat-poll__bar" aria-hidden style={{ inlineSize: `${percent}%` }} />
              {o.voters?.length ? (
                <span className="chat-poll__voters" id={votersId}>
                  {t('m.chat.poll.votedBy', { names: o.voters.map(name).join(', ') })}
                </span>
              ) : null}
            </div>
          );
        })}
      </fieldset>
      {/* Read out when someone votes, the poll ends, or you change your vote. */}
      <p className="chat-poll__status" id={`${legendId}-status`} role="status">
        {status}
      </p>
      {adding ? (
        <form
          className="chat-inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!text.trim()) return;
            if (await run(() => api.messages.addPollOption(message.id, text.trim()))) {
              setText('');
              setAdding(false);
            }
          }}
        >
          <label className="yp-visually-hidden" htmlFor={`${legendId}-new`}>
            {t('m.chat.poll.newOption')}
          </label>
          <input
            id={`${legendId}-new`}
            className="chat-inline-form__input"
            autoFocus
            maxLength={CHAT_POLL_OPTION_MAX}
            placeholder={t('m.chat.poll.newOption')}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setAdding(false);
            }}
          />
          <Button size="sm" type="submit" disabled={!text.trim() || busy}>
            {t('m.chat.poll.addOption')}
          </Button>
        </form>
      ) : null}
      {!poll.ended ? (
        <div className="chat-poll__actions">
          {voted && !poll.multiple ? (
            <button type="button" className="chat-link-button" disabled={busy} onClick={() => void run(() => api.messages.vote(message.id, []))}>
              {t('m.chat.poll.removeVote')}
            </button>
          ) : null}
          {canAdd && !adding ? (
            <button type="button" className="chat-link-button" onClick={() => setAdding(true)}>
              {t('m.chat.poll.addOption')}
            </button>
          ) : null}
          {creator ? (
            <button
              type="button"
              className="chat-link-button"
              disabled={busy}
              onClick={() => {
                if (confirm(t('m.chat.poll.endConfirm'))) void run(() => api.messages.endPoll(message.id));
              }}
            >
              {t('m.chat.poll.end')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ─── Shared list in a message ───────────────────────────────────────────

export function ListView({ message, meId, mine, onList }: { message: Message; meId?: string; mine: boolean; onList: (list: ChatList) => void }) {
  const { t, toast } = useSession();
  const list = message.list!;
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const titleId = useId();
  // After moving an item, focus stays on the same button in its new place.
  const [refocus, setRefocus] = useState<string | null>(null);
  useEffect(() => {
    if (!refocus) return;
    document.getElementById(refocus)?.focus();
    setRefocus(null);
  }, [refocus, list]);

  async function run(action: () => Promise<{ list: ChatList | null }>) {
    setBusy(true);
    try {
      const r = await action();
      if (r.list) onList(r.list);
      return true;
    } catch (e) {
      toast(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function move(index: number, by: -1 | 1, dir: 'up' | 'down') {
    if (busy) return;
    const ids = list.items.map((i) => i.id);
    const [item] = ids.splice(index, 1);
    ids.splice(index + by, 0, item!);
    onList({ ...list, items: ids.map((id) => list.items.find((i) => i.id === id)!) });
    const target = index + by === 0 ? 'down' : index + by === ids.length - 1 ? 'up' : dir;
    setRefocus(`${titleId}-${item}-${target}`);
    void run(() => api.messages.reorderList(message.id, ids));
  }

  const done = list.items.filter((i) => i.done).length;
  return (
    <div className={`chat-list${mine ? ' chat-list--mine' : ''}`}>
      <p className="chat-poll__label">
        <Icon name="check-circle" size={14} /> {t('m.chat.list.label')}
      </p>
      <p className="chat-list__title" id={titleId} dir="auto">
        {list.title}
      </p>
      <p className="chat-poll__status" role="status">
        {list.items.length ? t('m.chat.list.progress', { done, total: list.items.length }) : t('m.chat.list.empty')}
      </p>
      {list.items.length ? (
        <ul className="chat-list__items" aria-labelledby={titleId}>
          {list.items.map((item, i) => {
            const canRemove = item.addedBy?.id === meId || list.createdBy === meId;
            return (
              <li key={item.id} className="chat-list__item">
                <label className="chat-list__check">
                  <input
                    type="checkbox"
                    checked={item.done}
                    onChange={(e) => {
                      const on = e.currentTarget.checked;
                      if (busy) return;
                      void run(() => api.messages.tickListItem(message.id, item.id, on));
                    }}
                  />
                  <span className={item.done ? 'chat-list__text chat-list__text--done' : 'chat-list__text'} dir="auto">
                    {item.text}
                  </span>
                </label>
                <span className="chat-list__tools">
                  <button
                    type="button"
                    id={`${titleId}-${item.id}-up`}
                    className="yp-action chat-list__tool"
                    aria-label={t('m.chat.list.moveUp', { item: item.text })}
                    disabled={i === 0}
                    onClick={() => move(i, -1, 'up')}
                  >
                    <Icon name="chevron-down" size={16} className="chat-list__up" />
                  </button>
                  <button
                    type="button"
                    id={`${titleId}-${item.id}-down`}
                    className="yp-action chat-list__tool"
                    aria-label={t('m.chat.list.moveDown', { item: item.text })}
                    disabled={i === list.items.length - 1}
                    onClick={() => move(i, 1, 'down')}
                  >
                    <Icon name="chevron-down" size={16} />
                  </button>
                  {canRemove ? (
                    <button
                      type="button"
                      className="yp-action chat-list__tool"
                      aria-label={t('m.chat.list.remove', { item: item.text })}
                      disabled={busy}
                      onClick={() => void run(() => api.messages.removeListItem(message.id, item.id))}
                    >
                      <Icon name="x" size={16} />
                    </button>
                  ) : null}
                </span>
                {item.done && item.doneBy ? (
                  <span className="chat-list__by">
                    {t('m.chat.list.doneBy', { name: item.doneBy.id === meId ? t('m.chat.you') : item.doneBy.displayName })}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {list.items.length < list.max ? (
        <form
          className="chat-inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!text.trim()) return;
            if (await run(() => api.messages.addListItem(message.id, text.trim()))) setText('');
          }}
        >
          <label className="yp-visually-hidden" htmlFor={`${titleId}-new`}>
            {t('m.chat.list.newItem')}
          </label>
          <input
            id={`${titleId}-new`}
            className="chat-inline-form__input"
            maxLength={CHAT_LIST_ITEM_MAX}
            placeholder={t('m.chat.list.newItem')}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
          />
          <Button size="sm" type="submit" icon="plus" disabled={!text.trim() || busy}>
            {t('m.chat.list.addItem')}
          </Button>
        </form>
      ) : (
        <p className="chat-poll__status">{t('m.chat.list.full')}</p>
      )}
    </div>
  );
}

// ─── Making a poll or a list ────────────────────────────────────────────

export function PollSheet({
  open,
  onClose,
  conversationId,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  onSent: (m: Message) => void;
}) {
  const { t, toast } = useSession();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [allowAdd, setAllowAdd] = useState(false);
  const [ends, setEnds] = useState(false);
  const [endsAt, setEndsAt] = useState('');
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuestion('');
    setOptions(['', '']);
    setMultiple(false);
    setAnonymous(false);
    setAllowAdd(false);
    setEnds(false);
    setEndsAt(localInput(new Date(Date.now() + 86_400_000)));
  }, [open]);

  const filled = options.map((o) => o.trim()).filter(Boolean);
  const distinct = new Set(filled.map((o) => o.toLowerCase())).size === filled.length;
  const ready = !!question.trim() && filled.length >= CHAT_POLL_MIN_OPTIONS && distinct && (!ends || !!endsAt);

  async function submit() {
    if (!ready) return toast(t('m.chat.poll.needTwo'));
    setBusy(true);
    try {
      const { message } = await api.conversations.createPoll(conversationId, {
        question: question.trim(),
        options: filled,
        multiple,
        anonymous,
        allowAddOptions: allowAdd,
        endsAt: ends ? new Date(endsAt).toISOString() : null,
        clientId: crypto.randomUUID(),
      });
      onSent(message);
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={t('m.chat.poll.create')}>
      <form
        className="stack"
        style={{ gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          label={t('m.chat.poll.question')}
          placeholder={t('m.chat.poll.questionPlaceholder')}
          value={question}
          maxLength={CHAT_POLL_QUESTION_MAX}
          onChange={(e) => setQuestion(e.currentTarget.value)}
          required
        />
        <fieldset className="chat-radio">
          <legend className="yp-field__label">{t('m.chat.poll.options')}</legend>
          <div className="stack" style={{ gap: 8 }} ref={list}>
            {options.map((o, i) => (
              <div key={i} className="row" style={{ gap: 4 }}>
                <label className="yp-visually-hidden" htmlFor={`poll-opt-${i}`}>
                  {t('m.chat.poll.option', { n: i + 1 })}
                </label>
                <input
                  id={`poll-opt-${i}`}
                  className="yp-input"
                  style={{ flex: 1 }}
                  placeholder={t('m.chat.poll.option', { n: i + 1 })}
                  value={o}
                  maxLength={CHAT_POLL_OPTION_MAX}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    setOptions((cur) => cur.map((x, j) => (j === i ? v : x)));
                  }}
                />
                {options.length > CHAT_POLL_MIN_OPTIONS ? (
                  <button
                    type="button"
                    className="yp-action"
                    aria-label={t('m.chat.poll.removeOption', { n: i + 1 })}
                    onClick={() => {
                      setOptions((cur) => cur.filter((_, j) => j !== i));
                      // Focus goes to the option that takes its place (or the last one).
                      setTimeout(() => list.current?.querySelectorAll('input')[Math.min(i, options.length - 2)]?.focus(), 0);
                    }}
                  >
                    <Icon name="x" size={18} />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          {options.length < CHAT_POLL_MAX_OPTIONS ? (
            <Button
              size="sm"
              variant="ghost"
              icon="plus"
              onClick={() => {
                setOptions((cur) => [...cur, '']);
                setTimeout(() => list.current?.querySelectorAll('input')[options.length]?.focus(), 0);
              }}
            >
              {t('m.chat.poll.addOption')}
            </Button>
          ) : null}
          {!distinct ? (
            <p className="yp-field__error" role="alert">
              {t('m.chat.poll.distinct')}
            </p>
          ) : null}
        </fieldset>
        <Checkbox label={t('m.chat.poll.multiple')} checked={multiple} onChange={(e) => setMultiple(e.currentTarget.checked)} />
        <Checkbox
          label={t('m.chat.poll.anonymous')}
          description={t('m.chat.poll.anonymousHint')}
          checked={anonymous}
          onChange={(e) => setAnonymous(e.currentTarget.checked)}
        />
        <Checkbox label={t('m.chat.poll.allowAdd')} checked={allowAdd} onChange={(e) => setAllowAdd(e.currentTarget.checked)} />
        <Checkbox label={t('m.chat.poll.setEnd')} checked={ends} onChange={(e) => setEnds(e.currentTarget.checked)} />
        {ends ? (
          <TextField
            label={t('m.chat.poll.endsAt')}
            type="datetime-local"
            value={endsAt}
            min={localInput(new Date(Date.now() + 5 * 60_000))}
            max={localInput(new Date(Date.now() + CHAT_POLL_MAX_DAYS * 86_400_000))}
            onChange={(e) => setEndsAt(e.currentTarget.value)}
          />
        ) : null}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>
            {t('m.chat.cancel')}
          </Button>
          <Button type="submit" icon="poll" loading={busy} disabled={!ready}>
            {t('m.chat.poll.send')}
          </Button>
        </div>
      </form>
    </BottomSheet>
  );
}

export function ListSheet({
  open,
  onClose,
  conversationId,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  conversationId: string;
  onSent: (m: Message) => void;
}) {
  const { t, toast } = useSession();
  const [title, setTitle] = useState('');
  const [items, setItems] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setTitle('');
      setItems('');
    }
  }, [open]);
  const lines = items
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  async function submit() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const { message } = await api.conversations.createList(conversationId, {
        title: title.trim(),
        items: lines.slice(0, CHAT_LIST_MAX_ITEMS).map((l) => l.slice(0, CHAT_LIST_ITEM_MAX)),
        clientId: crypto.randomUUID(),
      });
      onSent(message);
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={t('m.chat.list.create')}>
      <form
        className="stack"
        style={{ gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          label={t('m.chat.list.title')}
          placeholder={t('m.chat.list.titlePlaceholder')}
          value={title}
          maxLength={CHAT_LIST_TITLE_MAX}
          onChange={(e) => setTitle(e.currentTarget.value)}
          required
        />
        <TextField
          multiline
          rows={5}
          label={t('m.chat.list.items')}
          hint={t('m.chat.list.itemsHint')}
          value={items}
          onChange={(e) => setItems(e.currentTarget.value)}
        />
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>
            {t('m.chat.cancel')}
          </Button>
          <Button type="submit" icon="check" loading={busy} disabled={!title.trim()}>
            {t('m.chat.list.send')}
          </Button>
        </div>
      </form>
    </BottomSheet>
  );
}

// ─── Reminders ──────────────────────────────────────────────────────────

/** Pick when to be reminded about a message: just you, or (group admins) the whole group. */
export function ReminderSheet({
  message,
  scope,
  onClose,
  onSet,
}: {
  message: Message | null;
  scope: 'me' | 'group';
  onClose: () => void;
  onSet: (reminder: ChatReminder) => void;
}) {
  const { t, locale, toast } = useSession();
  const [at, setAt] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (message) setAt(localInput(new Date(Date.now() + 60 * 60_000)));
  }, [message]);
  if (!message) return null;
  const now = new Date();
  const min = new Date(now.getTime() + 2 * 60_000);
  // A disappearing message can't be remembered past its time.
  const limit = now.getTime() + CHAT_REMINDER_MAX_DAYS * 86_400_000;
  const max = new Date(message.expiresAt ? Math.min(limit, new Date(message.expiresAt).getTime() - 60_000) : limit);
  const quick = quickChoices(now).filter((q) => q.at > min && q.at < max);

  async function save(date: Date) {
    setBusy(true);
    try {
      const { reminder } = await api.messages.remind(message!.id, date.toISOString(), scope);
      onSet(reminder);
      toast(t('m.chat.remind.set', { time: when(reminder.remindAt, locale) }));
      onClose();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <BottomSheet open onClose={onClose} title={scope === 'group' ? t('m.chat.remind.groupTitle') : t('m.chat.remind.title')}>
      <form
        className="stack"
        style={{ gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (at) void save(new Date(at));
        }}
      >
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          {scope === 'group' ? t('m.chat.remind.groupHint') : t('m.chat.remind.hint')}
        </p>
        {quick.length ? (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }} role="group" aria-label={t('m.picker.shortcuts')}>
            {quick.map((q) => (
              <Button key={q.id} size="sm" variant="secondary" disabled={busy} onClick={() => void save(q.at)}>
                {t(QUICK[q.id]!)}
              </Button>
            ))}
          </div>
        ) : null}
        <TextField
          label={t('m.chat.remind.when')}
          type="datetime-local"
          value={at}
          min={localInput(min)}
          max={localInput(max)}
          onChange={(e) => setAt(e.currentTarget.value)}
          required
        />
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>
            {t('m.chat.cancel')}
          </Button>
          <Button type="submit" icon="bell" loading={busy} disabled={!at}>
            {t('m.chat.remind.setButton')}
          </Button>
        </div>
      </form>
    </BottomSheet>
  );
}

/** "Reminder: Tue 4 Oct, 09:00" under a message you asked to be reminded about. */
export function ReminderNote({ at }: { at: string }) {
  const { t, locale } = useSession();
  return (
    <span className="chat-held chat-reminder-note">
      <Icon name="bell" size={12} /> {t('m.chat.remind.on', { time: when(at, locale) })}
    </span>
  );
}
