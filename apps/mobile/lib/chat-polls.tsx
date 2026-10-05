import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
} from '../../../packages/shared/src/constants';
import type { ChatList, ChatPoll, ChatReminder, Message } from '../../../packages/shared/src/types';
import { client, errorMessage } from './api';
import { DateField, DateTimeSheet, useWhenText } from './date-time';
import { useT } from './i18n';
import { radius, space } from './theme';
import { Button, Field, Icon, KeyboardAvoid, SwitchRow, useColors, userText, useScreenFocused } from './ui';

/**
 * Polls, shared lists and reminders in a chat (mobile). Polls are radio buttons (checkboxes when
 * several choices are allowed) that vote on tap; lists are checkboxes with move and remove
 * buttons. Results and progress are live regions, and changes are also announced on iOS.
 */

/** Announce a change to screen reader users (live regions cover Android; iOS needs this). */
function useAnnounce(text: string) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
  }, [text]);
}

// ─── Poll in a message ──────────────────────────────────────────────────

export function PollCard({ message, meId, tint, onPoll }: { message: Message; meId?: string; tint: string; onPoll: (poll: ChatPoll) => void }) {
  const { t, tp } = useT();
  const when = useWhenText();
  const poll = message.poll!;
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const creator = poll.createdBy === meId;
  const canAdd = !poll.ended && (poll.allowAddOptions || creator) && poll.options.length < CHAT_POLL_MAX_OPTIONS;
  const voted = poll.options.some((o) => o.mine);
  const status = [
    tp('m.chat.poll.voters', poll.voterCount),
    poll.ended ? t('m.chat.poll.ended') : poll.endsAt ? t('m.chat.poll.ends', { time: when(new Date(poll.endsAt)) }) : null,
    poll.anonymous ? t('m.chat.poll.anonymousNote') : null,
  ]
    .filter(Boolean)
    .join(' · ');
  useAnnounce(status);

  async function run(action: () => Promise<{ poll: ChatPoll | null }>) {
    setBusy(true);
    setError(null);
    try {
      const r = await action();
      if (r.poll) onPoll(r.poll);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const choose = (optionId: string, on: boolean) => {
    if (busy) return;
    const current = poll.options.filter((o) => o.mine).map((o) => o.id);
    const next = poll.multiple ? (on ? [...current, optionId] : current.filter((x) => x !== optionId)) : on ? [optionId] : [];
    void run(async () => (await client()).messages.vote(message.id, next));
  };
  const name = (u: { id: string; displayName: string }) => (u.id === meId ? t('m.chat.you') : u.displayName);

  return (
    <View style={{ gap: space[2], minWidth: 230 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Icon name="stats-chart-outline" size={12} color={tint} />
        <Text style={{ color: tint, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, opacity: 0.85 }}>{t('m.chat.poll.label')}</Text>
      </View>
      <Text accessibilityRole="header" style={[{ color: tint, fontSize: 16, fontWeight: '700' }, userText]}>
        {poll.question}
      </Text>
      <Text style={{ color: tint, fontSize: 12, opacity: 0.8 }}>{poll.multiple ? t('m.chat.poll.pickMany') : t('m.chat.poll.pickOne')}</Text>
      <View accessibilityRole={poll.multiple ? undefined : 'radiogroup'} accessibilityLabel={poll.question} style={{ gap: space[1] }}>
        {poll.options.map((o) => {
          const percent = poll.voterCount ? Math.round((o.votes / poll.voterCount) * 100) : 0;
          // Not disabled while a vote is saving (screen readers would read it as dimmed); taps wait instead.
          const disabled = poll.ended;
          return (
            <Pressable
              key={o.id}
              accessibilityRole={poll.multiple ? 'checkbox' : 'radio'}
              accessibilityState={{ checked: o.mine, disabled }}
              accessibilityLabel={`${o.text}, ${percent}%, ${tp('m.poll.votes', o.votes)}`}
              accessibilityHint={o.voters?.length ? t('m.chat.poll.votedBy', { names: o.voters.map(name).join(', ') }) : undefined}
              disabled={disabled}
              onPress={() => choose(o.id, !o.mine)}
              style={{
                minHeight: 44,
                borderRadius: radius.md,
                borderWidth: o.mine ? 2 : 1,
                borderColor: tint,
                overflow: 'hidden',
                justifyContent: 'center',
                paddingHorizontal: space[2],
                paddingVertical: space[1],
              }}
            >
              <View style={{ position: 'absolute', top: 0, bottom: 0, start: 0, width: `${percent}%`, backgroundColor: tint, opacity: 0.15 }} />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
                <Icon
                  name={poll.multiple ? (o.mine ? 'checkbox' : 'square-outline') : o.mine ? 'radio-button-on' : 'radio-button-off'}
                  size={20}
                  color={tint}
                />
                <Text style={[{ flexGrow: 1, flexShrink: 1, color: tint, fontSize: 15 }, userText]}>{o.text}</Text>
                <Text style={{ color: tint, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{percent}%</Text>
              </View>
              {o.voters?.length ? (
                <Text numberOfLines={2} style={[{ color: tint, fontSize: 12, opacity: 0.85, marginStart: 28 }, userText]}>
                  {t('m.chat.poll.votedBy', { names: o.voters.map(name).join(', ') })}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      <Text accessibilityLiveRegion="polite" style={{ color: tint, fontSize: 12, opacity: 0.85 }}>
        {status}
      </Text>
      {error ? <Text style={{ color: tint, fontSize: 13, fontWeight: '700' }}>{error}</Text> : null}
      {adding ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
          <TextInput
            autoFocus
            accessibilityLabel={t('m.chat.poll.newOption')}
            placeholder={t('m.chat.poll.newOption')}
            placeholderTextColor={tint}
            value={text}
            onChangeText={setText}
            maxLength={CHAT_POLL_OPTION_MAX}
            style={[{ flex: 1, minHeight: 40, borderRadius: radius.md, borderWidth: 1, borderColor: tint, color: tint, paddingHorizontal: space[2] }, userText]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('m.chat.poll.addOption')}
            disabled={!text.trim() || busy}
            onPress={async () => {
              if (await run(async () => (await client()).messages.addPollOption(message.id, text.trim()))) {
                setText('');
                setAdding(false);
              }
            }}
            hitSlop={4}
            style={{ padding: space[2], opacity: text.trim() ? 1 : 0.5 }}
          >
            <Icon name="add-circle" size={26} color={tint} />
          </Pressable>
        </View>
      ) : null}
      {!poll.ended ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[3] }}>
          {voted && !poll.multiple ? (
            <LinkButton label={t('m.chat.poll.removeVote')} tint={tint} onPress={() => void run(async () => (await client()).messages.vote(message.id, []))} />
          ) : null}
          {canAdd && !adding ? <LinkButton label={t('m.chat.poll.addOption')} tint={tint} onPress={() => setAdding(true)} /> : null}
          {creator ? (
            <LinkButton
              label={t('m.chat.poll.end')}
              tint={tint}
              onPress={() =>
                Alert.alert(t('m.chat.poll.end'), t('m.chat.poll.endConfirm'), [
                  { text: t('m.chat.cancel'), style: 'cancel' },
                  { text: t('m.chat.poll.end'), style: 'destructive', onPress: () => void run(async () => (await client()).messages.endPoll(message.id)) },
                ])
              }
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function LinkButton({ label, tint, onPress }: { label: string; tint: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={6} style={{ minHeight: 32, justifyContent: 'center' }}>
      <Text style={{ color: tint, fontSize: 13, fontWeight: '800', textDecorationLine: 'underline' }}>{label}</Text>
    </Pressable>
  );
}

// ─── Shared list in a message ───────────────────────────────────────────

export function ListCard({ message, meId, tint, onList }: { message: Message; meId?: string; tint: string; onList: (list: ChatList) => void }) {
  const { t } = useT();
  const list = message.list!;
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const done = list.items.filter((i) => i.done).length;
  const progress = list.items.length ? t('m.chat.list.progress', { done, total: list.items.length }) : t('m.chat.list.empty');
  useAnnounce(progress);

  async function run(action: () => Promise<{ list: ChatList | null }>) {
    setBusy(true);
    setError(null);
    try {
      const r = await action();
      if (r.list) onList(r.list);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function move(index: number, by: -1 | 1) {
    if (busy) return;
    const ids = list.items.map((i) => i.id);
    const [item] = ids.splice(index, 1);
    ids.splice(index + by, 0, item!);
    onList({ ...list, items: ids.map((id) => list.items.find((i) => i.id === id)!) });
    void run(async () => (await client()).messages.reorderList(message.id, ids));
  }

  return (
    <View style={{ gap: space[1], minWidth: 230 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Icon name="checkbox-outline" size={12} color={tint} />
        <Text style={{ color: tint, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, opacity: 0.85 }}>{t('m.chat.list.label')}</Text>
      </View>
      <Text accessibilityRole="header" style={[{ color: tint, fontSize: 16, fontWeight: '700' }, userText]}>
        {list.title}
      </Text>
      <Text accessibilityLiveRegion="polite" style={{ color: tint, fontSize: 12, opacity: 0.85 }}>
        {progress}
      </Text>
      {list.items.map((item, i) => {
        const canRemove = item.addedBy?.id === meId || list.createdBy === meId;
        const by = item.done && item.doneBy ? t('m.chat.list.doneBy', { name: item.doneBy.id === meId ? t('m.chat.you') : item.doneBy.displayName }) : null;
        return (
          <View key={item.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: item.done }}
              accessibilityLabel={item.text}
              accessibilityHint={by ?? undefined}
              onPress={() => {
                if (!busy) void run(async () => (await client()).messages.tickListItem(message.id, item.id, !item.done));
              }}
              // Moving items with a screen reader: the actions menu on the item.
              accessibilityActions={[
                ...(i > 0 ? [{ name: 'up', label: t('m.chat.list.moveUp', { item: item.text }) }] : []),
                ...(i < list.items.length - 1 ? [{ name: 'down', label: t('m.chat.list.moveDown', { item: item.text }) }] : []),
                ...(canRemove ? [{ name: 'remove', label: t('m.chat.list.remove', { item: item.text }) }] : []),
              ]}
              onAccessibilityAction={(e) => {
                const a = e.nativeEvent.actionName;
                if (a === 'up') move(i, -1);
                else if (a === 'down') move(i, 1);
                else if (a === 'remove') void run(async () => (await client()).messages.removeListItem(message.id, item.id));
              }}
              // 40pt tall, with the items 4pt apart; the touch area reaches 44.
              hitSlop={{ top: 2, bottom: 2 }}
              style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 40 }}
            >
              <Icon name={item.done ? 'checkbox' : 'square-outline'} size={20} color={tint} />
              <View style={{ flex: 1 }}>
                <Text style={[{ color: tint, fontSize: 15, textDecorationLine: item.done ? 'line-through' : 'none', opacity: item.done ? 0.75 : 1 }, userText]}>
                  {item.text}
                </Text>
                {by ? <Text style={[{ color: tint, fontSize: 12, opacity: 0.8 }, userText]}>{by}</Text> : null}
              </View>
            </Pressable>
            <IconButton icon="chevron-up" label={t('m.chat.list.moveUp', { item: item.text })} tint={tint} disabled={i === 0} onPress={() => move(i, -1)} />
            <IconButton
              icon="chevron-down"
              label={t('m.chat.list.moveDown', { item: item.text })}
              tint={tint}
              disabled={i === list.items.length - 1}
              onPress={() => move(i, 1)}
            />
            {canRemove ? (
              <IconButton
                icon="close"
                label={t('m.chat.list.remove', { item: item.text })}
                tint={tint}
                disabled={busy}
                onPress={() => void run(async () => (await client()).messages.removeListItem(message.id, item.id))}
              />
            ) : null}
          </View>
        );
      })}
      {error ? <Text style={{ color: tint, fontSize: 13, fontWeight: '700' }}>{error}</Text> : null}
      {list.items.length < list.max ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], marginTop: space[1] }}>
          <TextInput
            accessibilityLabel={t('m.chat.list.newItem')}
            placeholder={t('m.chat.list.newItem')}
            placeholderTextColor={tint}
            value={text}
            onChangeText={setText}
            maxLength={CHAT_LIST_ITEM_MAX}
            returnKeyType="done"
            onSubmitEditing={async () => {
              if (text.trim() && (await run(async () => (await client()).messages.addListItem(message.id, text.trim())))) setText('');
            }}
            style={[{ flex: 1, minHeight: 40, borderRadius: radius.md, borderWidth: 1, borderColor: tint, color: tint, paddingHorizontal: space[2] }, userText]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('m.chat.list.addItem')}
            disabled={!text.trim() || busy}
            onPress={async () => {
              if (await run(async () => (await client()).messages.addListItem(message.id, text.trim()))) setText('');
            }}
            hitSlop={5}
            style={{ padding: space[1], opacity: text.trim() ? 1 : 0.5 }}
          >
            <Icon name="add-circle" size={26} color={tint} />
          </Pressable>
        </View>
      ) : (
        <Text style={{ color: tint, fontSize: 12, opacity: 0.85 }}>{t('m.chat.list.full')}</Text>
      )}
    </View>
  );
}

function IconButton({
  icon,
  label,
  tint,
  disabled,
  onPress,
}: {
  icon: React.ComponentProps<typeof Icon>['name'];
  label: string;
  tint: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      // The checkbox's actions menu does the same for screen readers.
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      disabled={disabled}
      onPress={onPress}
      // 44 wide (the buttons sit side by side, so slop can't widen them); 40 tall, and the slop takes it to 44.
      hitSlop={{ top: 2, bottom: 2 }}
      style={{ width: 44, height: 40, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.35 : 1 }}
    >
      <Icon name={icon} size={18} color={tint} />
    </Pressable>
  );
}

// ─── Making a poll or a list ────────────────────────────────────────────

/** A full-screen form with a title bar: Cancel, the title, and the send button. */
function FormModal({
  open,
  title,
  sendLabel,
  canSend,
  busy,
  onClose,
  onSend,
  children,
}: {
  open: boolean;
  title: string;
  sendLabel: string;
  canSend: boolean;
  busy: boolean;
  onClose: () => void;
  onSend: () => void;
  children: React.ReactNode;
}) {
  const focused = useScreenFocused();
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open && focused} animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoid offset={0} style={{ backgroundColor: c.ground }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingTop: insets.top + space[2],
            paddingHorizontal: space[3],
            paddingBottom: space[2],
            borderBottomWidth: 1,
            borderBottomColor: c.line,
          }}
        >
          <Pressable accessibilityRole="button" onPress={onClose} hitSlop={8} style={{ minHeight: 44, justifyContent: 'center' }}>
            <Text style={{ color: c.yapi, fontSize: 16, fontWeight: '600' }}>{t('m.chat.cancel')}</Text>
          </Pressable>
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
            {title}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !canSend || busy, busy }}
            disabled={!canSend || busy}
            onPress={onSend}
            hitSlop={8}
            style={{ minHeight: 44, justifyContent: 'center', opacity: canSend && !busy ? 1 : 0.45 }}
          >
            <Text style={{ color: c.yapi, fontSize: 16, fontWeight: '800' }}>{sendLabel}</Text>
          </Pressable>
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: insets.bottom + space[6] }}>
          {children}
        </ScrollView>
      </KeyboardAvoid>
    </Modal>
  );
}

export function PollComposer({
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
  const c = useColors();
  const { t } = useT();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [allowAdd, setAllowAdd] = useState(false);
  const [endsAt, setEndsAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuestion('');
    setOptions(['', '']);
    setMultiple(false);
    setAnonymous(false);
    setAllowAdd(false);
    setEndsAt(null);
    setError(null);
  }, [open]);

  const filled = options.map((o) => o.trim()).filter(Boolean);
  const distinct = new Set(filled.map((o) => o.toLowerCase())).size === filled.length;
  const ready = !!question.trim() && filled.length >= CHAT_POLL_MIN_OPTIONS && distinct;

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const { message } = await (
        await client()
      ).conversations.createPoll(conversationId, {
        question: question.trim(),
        options: filled,
        multiple,
        anonymous,
        allowAddOptions: allowAdd,
        endsAt: endsAt ? endsAt.toISOString() : null,
        clientId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      onSent(message);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormModal
      open={open}
      title={t('m.chat.poll.create')}
      sendLabel={t('m.chat.poll.send')}
      canSend={ready}
      busy={busy}
      onClose={onClose}
      onSend={() => void send()}
    >
      {error ? <Text style={{ color: c.danger }}>{error}</Text> : null}
      <Field
        label={t('m.chat.poll.question')}
        placeholder={t('m.chat.poll.questionPlaceholder')}
        value={question}
        onChangeText={setQuestion}
        maxLength={CHAT_POLL_QUESTION_MAX}
        autoFocus
      />
      <View style={{ gap: space[2] }}>
        <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.chat.poll.options')}</Text>
        {options.map((o, i) => (
          <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <View style={{ flex: 1 }}>
              <Field
                hideLabel
                label={t('m.chat.poll.option', { n: i + 1 })}
                placeholder={t('m.chat.poll.option', { n: i + 1 })}
                value={o}
                maxLength={CHAT_POLL_OPTION_MAX}
                onChangeText={(v) => setOptions((cur) => cur.map((x, j) => (j === i ? v : x)))}
              />
            </View>
            {options.length > CHAT_POLL_MIN_OPTIONS ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('m.chat.poll.removeOption', { n: i + 1 })}
                hitSlop={8}
                onPress={() => setOptions((cur) => cur.filter((_, j) => j !== i))}
                style={{ padding: space[1] }}
              >
                <Icon name="close-circle-outline" size={24} color={c.inkMuted} />
              </Pressable>
            ) : null}
          </View>
        ))}
        {!distinct ? <Text style={{ color: c.danger, fontSize: 13 }}>{t('m.chat.poll.distinct')}</Text> : null}
        {options.length < CHAT_POLL_MAX_OPTIONS ? (
          <Button label={t('m.chat.poll.addOption')} icon="add" variant="ghost" size="sm" onPress={() => setOptions((cur) => [...cur, ''])} />
        ) : null}
      </View>
      <SwitchRow label={t('m.chat.poll.multiple')} value={multiple} onValueChange={setMultiple} />
      <SwitchRow label={t('m.chat.poll.anonymous')} hint={t('m.chat.poll.anonymousHint')} value={anonymous} onValueChange={setAnonymous} />
      <SwitchRow label={t('m.chat.poll.allowAdd')} value={allowAdd} onValueChange={setAllowAdd} />
      <SwitchRow label={t('m.chat.poll.setEnd')} value={!!endsAt} onValueChange={(on) => setEndsAt(on ? new Date(Date.now() + 86_400_000) : null)} />
      {endsAt ? (
        <DateField
          label={t('m.chat.poll.endsAt')}
          value={endsAt}
          onChange={setEndsAt}
          min={new Date(Date.now() + 10 * 60_000)}
          max={new Date(Date.now() + CHAT_POLL_MAX_DAYS * 86_400_000)}
          quick
        />
      ) : null}
    </FormModal>
  );
}

export function ListComposer({
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
  const c = useColors();
  const { t } = useT();
  const [title, setTitle] = useState('');
  const [items, setItems] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setTitle('');
      setItems('');
      setError(null);
    }
  }, [open]);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const lines = items
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, CHAT_LIST_MAX_ITEMS)
        .map((l) => l.slice(0, CHAT_LIST_ITEM_MAX));
      const { message } = await (
        await client()
      ).conversations.createList(conversationId, {
        title: title.trim(),
        items: lines,
        clientId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      onSent(message);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormModal
      open={open}
      title={t('m.chat.list.create')}
      sendLabel={t('m.chat.list.send')}
      canSend={!!title.trim()}
      busy={busy}
      onClose={onClose}
      onSend={() => void send()}
    >
      {error ? <Text style={{ color: c.danger }}>{error}</Text> : null}
      <Field
        label={t('m.chat.list.title')}
        placeholder={t('m.chat.list.titlePlaceholder')}
        value={title}
        onChangeText={setTitle}
        maxLength={CHAT_LIST_TITLE_MAX}
        autoFocus
      />
      <Field label={t('m.chat.list.items')} value={items} onChangeText={setItems} multiline style={{ minHeight: 120, textAlignVertical: 'top' }} />
      <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.chat.list.itemsHint')}</Text>
    </FormModal>
  );
}

// ─── Reminders ──────────────────────────────────────────────────────────

/** Pick when to be reminded about a message (just you), or, for group admins, to remind the group. */
export function ReminderPicker({
  message,
  scope,
  onClose,
  onSet,
  onError,
}: {
  message: Message | null;
  scope: 'me' | 'group';
  onClose: () => void;
  onSet: (reminder: ChatReminder) => void;
  onError: (message: string) => void;
}) {
  const { t } = useT();
  const when = useWhenText();
  const now = Date.now();
  const limit = now + CHAT_REMINDER_MAX_DAYS * 86_400_000;
  // A disappearing message can't be remembered past its time.
  const max = new Date(message?.expiresAt ? Math.min(limit, new Date(message.expiresAt).getTime() - 60_000) : limit);
  return (
    <DateTimeSheet
      visible={!!message}
      title={scope === 'group' ? t('m.chat.remind.groupTitle') : t('m.chat.remind.title')}
      value={new Date(now + 60 * 60_000)}
      min={new Date(now + 5 * 60_000)}
      max={max}
      quick
      hint={scope === 'group' ? t('m.chat.remind.groupHint') : t('m.chat.remind.hint')}
      confirmLabel={() => t('m.chat.remind.setButton')}
      onClose={onClose}
      onPick={async (at) => {
        const target = message;
        onClose();
        if (!target) return;
        try {
          const { reminder } = await (await client()).messages.remind(target.id, at.toISOString(), scope);
          onSet(reminder);
          AccessibilityInfo.announceForAccessibility(t('m.chat.remind.set', { time: when(new Date(reminder.remindAt)) }));
        } catch (e) {
          onError(errorMessage(e));
        }
      }}
    />
  );
}

/** "Reminder: Tomorrow at 9:00" under a message you asked to be reminded about. */
export function ReminderNote({ at, alignEnd }: { at: string; alignEnd: boolean }) {
  const c = useColors();
  const { t } = useT();
  const when = useWhenText();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: alignEnd ? 'flex-end' : 'flex-start' }}>
      <Icon name="notifications-outline" size={12} color={c.inkMuted} />
      <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t('m.chat.remind.on', { time: when(new Date(at)) })}</Text>
    </View>
  );
}
