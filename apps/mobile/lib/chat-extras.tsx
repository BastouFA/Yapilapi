import { router } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, FlatList, I18nManager, Modal, PanResponder, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Conversation, Message, MessagePreview, PinnedMessage } from '../../../packages/shared/src/types';
import { patiently } from '../../../packages/api-client/src/index';
import { FORWARD_MAX_CHATS } from '../../../packages/shared/src/schemas';
import type { MessageKey } from '../../../packages/shared/src/i18n-core';
import { chatTheme } from '../../../packages/shared/src/chat-theme';
import { chessDrawReason } from '../../../packages/shared/src/games/index';
import { callLineText, groupLineText, messagePreviewOf, messagePreviewText, watchLineText } from '../../../packages/shared/src/message-preview';
import { client, errorMessage } from './api';
import { useT } from './i18n';
import { useSession } from './session';
import { radius, space } from './theme';
import { conversationTitle } from './post';
import { ActionSheet, Avatar, BottomSheet, Button, Icon, useColors, userText, useScreenFocused } from './ui';
import { openWatch } from './watch';

/**
 * Chat extras: quoted replies, reactions, pinned messages, search, disappearing
 * messages and the long-press menu. Used by app/chat/[id].tsx.
 */

/** Quick reactions offered on every message. */
import * as SecureStore from 'expo-secure-store';
import {
  favouriteReactions,
  inTone,
  QUICK_REACTIONS,
  REACTION_GROUPS,
  readTone,
  rememberReaction,
  SKIN_TONES,
  type SkinTone,
  withTone,
} from '../../../packages/shared/src/reactions';
export { QUICK_REACTIONS };
export const DISAPPEARING_OPTIONS: (number | null)[] = [null, 86_400, 604_800, 7_776_000];

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function disappearingText(t: T, seconds: number | null | undefined): string {
  if (seconds === 86_400) return t('m.chat.hours24');
  if (seconds === 604_800) return t('m.chat.days7');
  if (seconds === 7_776_000) return t('m.chat.days90');
  return t('m.chat.off');
}

/**
 * One line describing a quoted message, in the reader's language (messagePreviewText in
 * packages/shared). `meId` says whose story a story reply answered; `locale` formats amounts.
 */
export function previewText(t: T, p: MessagePreview, o: { meId?: string; locale?: string } = {}): string {
  return messagePreviewText(p, { t, ...o });
}

/** A message as a quote, for the reply bar before sending. */
export const previewOf = messagePreviewOf;

/** Adds or removes one reaction on a message locally. */
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

/** The quoted original inside a reply bubble; tapping it goes to the original. */
export function Quote({ preview, tint, meId, onJump }: { preview: MessagePreview; tint: string; meId?: string; onJump: (id: string) => void }) {
  const { t, locale } = useT();
  const who = !preview.available ? null : preview.sender?.id === meId ? t('m.chat.you') : (preview.sender?.displayName ?? null);
  const text = previewText(t, preview, { meId, locale });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={who ? `${t('m.chat.goTo', { name: who })}. ${text}` : text}
      disabled={!preview.available}
      onPress={() => onJump(preview.id)}
      // About 37pt tall with a name and one line; the touch area reaches 44.
      hitSlop={{ top: 4, bottom: 4 }}
      style={{ borderStartWidth: 3, borderStartColor: tint, paddingStart: space[2], paddingVertical: 2, marginBottom: space[1], opacity: 0.9 }}
    >
      {who ? <Text style={[{ color: tint, fontSize: 12, fontWeight: '700' }, userText]}>{who}</Text> : null}
      <Text numberOfLines={2} style={[{ color: tint, fontSize: 13, fontStyle: preview.available ? 'normal' : 'italic' }, userText]}>
        {text}
      </Text>
    </Pressable>
  );
}

/** Reaction counts under a bubble; tapping one adds or removes yours. */
export function ReactionRow({ message, mine, onToggle }: { message: Message; mine: boolean; onToggle: (emoji: string, on: boolean) => void }) {
  const c = useColors();
  const { t } = useT();
  if (!message.reactions?.length) return null;
  return (
    // rowGap 16: chips that wrap onto a second row keep their 44pt touch areas apart.
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 4, rowGap: 16, alignSelf: mine ? 'flex-end' : 'flex-start', marginTop: -2 }}>
      {message.reactions.map((r) => (
        <Pressable
          key={r.emoji}
          accessibilityRole="button"
          accessibilityState={{ selected: r.mine }}
          accessibilityLabel={t('m.chat.reactionA11y', { emoji: r.emoji, count: r.count })}
          onPress={() => onToggle(r.emoji, !r.mine)}
          // 28pt tall; the touch area still reaches 44pt. Sideways the chips are 4pt apart, so
          // they share the gap (each chip is about 44 wide already).
          hitSlop={{ top: 8, bottom: 8, left: 2, right: 2 }}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            minHeight: 28,
            paddingHorizontal: space[2],
            borderRadius: radius.full,
            borderWidth: 1,
            borderColor: r.mine ? c.yapi : c.line,
            backgroundColor: c.surface,
          }}
        >
          <Text style={{ fontSize: 13 }}>{r.emoji}</Text>
          <Text style={{ color: c.ink, fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{r.count}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Swipe a message sideways (towards the middle of the screen) to reply to it. */
export function SwipeToReply({ onReply, children, enabled }: { onReply: () => void; children: ReactNode; enabled: boolean }) {
  const x = useRef(new Animated.Value(0)).current;
  const dir = I18nManager.isRTL ? -1 : 1;
  const reply = useRef(onReply);
  reply.current = onReply;
  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => g.dx * dir > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 2,
      onPanResponderMove: (_e, g) => x.setValue(Math.max(0, Math.min(80, g.dx * dir)) * dir),
      onPanResponderRelease: (_e, g) => {
        if (g.dx * dir > 64) reply.current();
        Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
      },
      onPanResponderTerminate: () => Animated.spring(x, { toValue: 0, useNativeDriver: true }).start(),
    }),
  ).current;
  if (!enabled) return <>{children}</>;
  return (
    <Animated.View {...responder.panHandlers} style={{ transform: [{ translateX: x }] }}>
      {children}
    </Animated.View>
  );
}

/**
 * A line in the chat that tells everyone who changed disappearing messages, or a group reminder at
 * its time (tapping it goes to the message it's about).
 */
export function SystemLine({
  message,
  meId,
  onJump,
  watchLive,
}: {
  message: Message;
  meId?: string;
  onJump?: (id: string) => void;
  /** A "started watching together" line whose session still runs: it gets a Join button. */
  watchLive?: boolean;
}) {
  const c = useColors();
  const { t, tp, locale } = useT();
  const name = message.sender.id === meId ? t('m.chat.you') : message.sender.displayName;
  const s = message.system;
  if (s?.type === 'together') {
    // "Ada started a shared album: Lagos weekend", with a way in (people not in it see that it isn't for them).
    const text =
      message.sender.id === meId
        ? t('together.chat.cardYou', { title: s.title })
        : t('together.chat.card', { name: message.sender.displayName, title: s.title });
    return (
      <View style={{ alignSelf: 'center', alignItems: 'center', gap: space[1], maxWidth: '90%', paddingVertical: space[1] }}>
        <View style={{ flexDirection: 'row', gap: space[1], alignItems: 'center' }}>
          <Icon name="images-outline" size={14} color={c.inkMuted} />
          <Text style={[{ color: c.inkMuted, fontSize: 13, textAlign: 'center', lineHeight: 18 }, userText]}>{text}</Text>
        </View>
        <Button label={t('together.chat.open')} size="sm" variant="secondary" icon="images-outline" onPress={() => router.push(`/together/${s.togetherId}`)} />
      </View>
    );
  }
  // A plan's chat: its maker changed the plan or cancelled it, with a way to the plan.
  if (s?.type === 'plan')
    return (
      <View style={{ alignSelf: 'center', alignItems: 'center', gap: space[1], maxWidth: '90%', paddingVertical: space[1] }}>
        <View style={{ flexDirection: 'row', gap: space[1], alignItems: 'center' }}>
          <Icon name="calendar-outline" size={14} color={c.inkMuted} />
          <Text style={[{ color: c.inkMuted, fontSize: 13, textAlign: 'center', lineHeight: 18 }, userText]}>
            {t(s.action === 'cancelled' ? 'plans.line.cancelled' : 'plans.line.changed', { name })}
          </Text>
        </View>
        <Button
          label={t('plans.open')}
          size="sm"
          variant="secondary"
          icon="calendar-outline"
          onPress={() => router.push({ pathname: '/go/[id]', params: { id: s.planId } })}
        />
      </View>
    );
  if (s?.type === 'watch') {
    // "Ada started watching together" with Join while it runs; "Watched together · 12 minutes" once it ended.
    const text = watchLineText(s, message.sender.id, message.sender.displayName, { t, tp, locale, meId });
    return (
      <View style={{ alignSelf: 'center', alignItems: 'center', gap: space[1], maxWidth: '90%', paddingVertical: space[1] }}>
        <View style={{ flexDirection: 'row', gap: space[1], alignItems: 'center' }}>
          <Icon name="tv-outline" size={14} color={c.inkMuted} />
          <Text style={[{ color: c.inkMuted, fontSize: 13, textAlign: 'center', lineHeight: 18 }, userText]}>{text}</Text>
        </View>
        {watchLive && !s.ended ? <Button label={t('watch.join')} size="sm" variant="secondary" icon="play" onPress={() => openWatch(s.sessionId)} /> : null}
      </View>
    );
  }
  // "Ada added 3 songs to Road trip": several adds by one person within ten minutes share the line.
  if (s?.type === 'mix') {
    const text = tp('mixes.line', s.count, { name, title: s.title });
    return (
      <Pressable
        accessibilityRole="link"
        onPress={() => router.push({ pathname: '/mixes/[id]', params: { id: s.mixId } })}
        style={{ alignSelf: 'center', flexDirection: 'row', gap: space[1], alignItems: 'center', maxWidth: '90%', paddingVertical: space[1], minHeight: 44 }}
      >
        <Icon name="list-outline" size={14} color={c.inkMuted} />
        <Text style={[{ color: c.inkMuted, fontSize: 13, textAlign: 'center', lineHeight: 18, textDecorationLine: 'underline' }, userText]}>{text}</Text>
      </Pressable>
    );
  }
  if (s?.type === 'reminder') {
    const about = s.message;
    const text = about?.available ? t('m.chat.systemReminder', { name, text: previewText(t, about, { meId }) }) : t('m.chat.systemReminderGone', { name });
    return (
      <Pressable
        accessibilityRole={about?.available && onJump ? 'button' : 'text'}
        disabled={!about?.available || !onJump}
        onPress={() => onJump?.(s.messageId)}
        hitSlop={6}
        style={{ alignSelf: 'center', flexDirection: 'row', gap: space[1], alignItems: 'center', maxWidth: '90%', paddingVertical: space[1], minHeight: 32 }}
      >
        <Icon name="notifications-outline" size={14} color={c.inkMuted} />
        <Text style={[{ color: c.inkMuted, fontSize: 13, textAlign: 'center', lineHeight: 18 }, userText]}>{text}</Text>
      </Pressable>
    );
  }
  if (s?.type === 'theme') {
    const look = chatTheme(s);
    const text = t('m.chat.systemTheme', {
      name,
      wallpaper: t(`m.chat.wallpaper.${look.wallpaper}` as MessageKey),
      colour: t(`m.chat.accent.${look.accent}` as MessageKey),
    });
    return (
      <View style={{ alignSelf: 'center', flexDirection: 'row', gap: space[1], alignItems: 'center', maxWidth: '90%', paddingVertical: space[1] }}>
        <Icon name="color-palette-outline" size={14} color={c.inkMuted} />
        <Text style={[{ color: c.inkMuted, fontSize: 13, textAlign: 'center', lineHeight: 18 }, userText]}>{text}</Text>
      </View>
    );
  }
  if (s?.type === 'call')
    return (
      <View style={{ alignSelf: 'center', flexDirection: 'row', gap: space[1], alignItems: 'center', maxWidth: '90%', paddingVertical: space[1] }}>
        <Icon name={s.kind === 'video' ? 'videocam-outline' : 'call-outline'} size={14} color={c.inkMuted} />
        <Text style={[{ color: c.inkMuted, fontSize: 13, textAlign: 'center', lineHeight: 18 }, userText]}>
          {callLineText(s, message.sender.id, { t, tp, locale, meId })}
        </Text>
      </View>
    );
  if (s?.type === 'group')
    return (
      <View style={{ alignSelf: 'center', flexDirection: 'row', gap: space[1], alignItems: 'center', maxWidth: '90%', paddingVertical: space[1] }}>
        <Icon name="people-outline" size={14} color={c.inkMuted} />
        <Text style={[{ color: c.inkMuted, fontSize: 13, textAlign: 'center', lineHeight: 18 }, userText]}>{groupLineText(s, name, { t, locale, meId })}</Text>
      </View>
    );
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
            { name, game },
          )
        : s.outcome === 'draw'
          ? s.reason
            ? t('m.chat.systemChessDraw', { game, reason: chessDrawReason(t, s.reason) })
            : t('m.chat.systemGameDraw', { game })
          : t('m.chat.systemGameUnfinished', { game });
    return (
      <View style={{ alignSelf: 'center', flexDirection: 'row', gap: space[1], alignItems: 'center', maxWidth: '90%', paddingVertical: space[1] }}>
        <Icon name="game-controller-outline" size={14} color={c.inkMuted} />
        <Text style={[{ color: c.inkMuted, fontSize: 13, textAlign: 'center', lineHeight: 18 }, userText]}>{text}</Text>
      </View>
    );
  }
  if (s?.type !== 'disappearing') return null;
  const text = s.seconds ? t('m.chat.systemOn', { name, time: disappearingText(t, s.seconds) }) : t('m.chat.systemOff', { name });
  return (
    <View style={{ alignSelf: 'center', flexDirection: 'row', gap: space[1], alignItems: 'center', maxWidth: '90%', paddingVertical: space[1] }}>
      <Icon name="timer-outline" size={14} color={c.inkMuted} />
      <Text style={[{ color: c.inkMuted, fontSize: 13, textAlign: 'center', lineHeight: 18 }, userText]}>{text}</Text>
    </View>
  );
}

/** Pinned messages at the top of the chat. Tapping goes to the message; with several, the next one shows. */
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
  const c = useColors();
  const { t, locale } = useT();
  const { me } = useSession();
  const [i, setI] = useState(0);
  if (!pins.length) return null;
  const at = Math.min(i, pins.length - 1);
  const pin = pins[at]!;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[2],
        paddingStart: space[4],
        paddingEnd: space[2],
        paddingVertical: space[2],
        backgroundColor: c.surface,
        borderBottomWidth: 1,
        borderBottomColor: c.line,
      }}
    >
      <Icon name="pin-outline" size={18} color={c.yapi} />
      <Pressable
        accessibilityRole="button"
        // Two lines, about 34pt; the bar's padding takes the touch area to 44.
        hitSlop={{ top: 6, bottom: 6 }}
        style={{ flex: 1 }}
        onPress={() => {
          onJump(pin.message.id);
          setI((at + 1) % pins.length);
        }}
      >
        <Text style={{ color: c.yapi, fontSize: 12, fontWeight: '700' }}>
          {pins.length > 1 ? t('m.chat.pinnedOf', { n: at + 1, total: pins.length }) : t('m.chat.pinned')}
        </Text>
        <Text numberOfLines={1} style={[{ color: c.ink, fontSize: 14 }, userText]}>
          {pin.message.sender ? `${pin.message.sender.displayName}: ` : ''}
          {previewText(t, pin.message, { meId: me?.id, locale })}
        </Text>
      </Pressable>
      {canManage ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('m.chat.unpinA11y')}
          // 28 × 26; the side slop stops at the pinned message 8pt away.
          hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
          onPress={() => onUnpin(pin.message.id)}
          style={{ paddingVertical: space[1], paddingHorizontal: space[1] + 1 }}
        >
          <Icon name="close" size={18} color={c.inkMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

export interface SheetAction {
  label: string;
  icon: React.ComponentProps<typeof Icon>['name'];
  danger?: boolean;
  onPress: () => void;
}

// ── Your emojis: the ones you used lately, kept on this phone ──
const RECENT_KEY = 'reactions.recent';
let recent: string[] = [];
let recentLoaded = false;
const recentListeners = new Set<(r: string[]) => void>();
function loadRecent() {
  if (recentLoaded) return;
  recentLoaded = true;
  SecureStore.getItemAsync(RECENT_KEY)
    .then((v) => {
      const list: unknown = JSON.parse(v ?? '[]');
      recent = Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
      recentListeners.forEach((l) => l(recent));
    })
    .catch(() => {});
}
function noteReaction(emoji: string) {
  recent = rememberReaction(recent, emoji);
  recentListeners.forEach((l) => l(recent));
  void SecureStore.setItemAsync(RECENT_KEY, JSON.stringify(recent)).catch(() => {});
}
function useRecentReactions(): string[] {
  const [r, setR] = useState(recent);
  useEffect(() => {
    loadRecent();
    recentListeners.add(setR);
    setR(recent);
    return () => void recentListeners.delete(setR);
  }, []);
  return r;
}

// ── Your skin colour for emojis, kept on this phone ──
const TONE_KEY = 'reactions.tone';
let tone: SkinTone = '';
let toneLoaded = false;
const toneListeners = new Set<(t: SkinTone) => void>();
function chooseSkinTone(next: SkinTone) {
  tone = next;
  toneListeners.forEach((l) => l(next));
  void SecureStore.setItemAsync(TONE_KEY, next).catch(() => {});
}
function useSkinTone(): SkinTone {
  const [current, setCurrent] = useState(tone);
  useEffect(() => {
    if (!toneLoaded) {
      toneLoaded = true;
      SecureStore.getItemAsync(TONE_KEY)
        .then((v) => {
          tone = readTone(v);
          toneListeners.forEach((l) => l(tone));
        })
        .catch(() => {});
    }
    toneListeners.add(setCurrent);
    setCurrent(tone);
    return () => void toneListeners.delete(setCurrent);
  }, []);
  return current;
}

// ── A voice message copied in a chat, to paste into another: clipboards don't take sound ──
export type CopiedVoice = { messageId: string; durationMs: number | null; at: number };
/** How long a copied voice message waits to be pasted. */
const COPIED_KEEP_MS = 30 * 60_000;
let copied: CopiedVoice | null = null;
const copiedListeners = new Set<(v: CopiedVoice | null) => void>();
function setCopied(v: CopiedVoice | null) {
  copied = v;
  copiedListeners.forEach((l) => l(v));
}
export const copyVoice = (messageId: string, durationMs: number | null) => setCopied({ messageId, durationMs, at: Date.now() });
export const clearCopiedVoice = () => setCopied(null);
export function useCopiedVoice(): CopiedVoice | null {
  const [v, setV] = useState(copied);
  useEffect(() => {
    copiedListeners.add(setV);
    setV(copied);
    return () => void copiedListeners.delete(setV);
  }, []);
  return v && Date.now() - v.at < COPIED_KEEP_MS ? v : null;
}

/** Forward a message: choose up to FORWARD_MAX_CHATS of your chats, and a copy goes to each. */
export function ForwardSheet({ message, onClose, onForwarded }: { message: Message | null; onClose: () => void; onForwarded: (messages: Message[]) => void }) {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const [chats, setChats] = useState<Conversation[] | null>(null);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const messageId = message?.id;
  useEffect(() => {
    if (!messageId) return;
    setQuery('');
    setChosen([]);
    setProblem(null);
    setChats(null);
    void client()
      .then((api) => api.conversations.list())
      .then(
        (r) => setChats(r.items.filter((x) => x.kind !== 'community')),
        (e) => {
          setProblem(errorMessage(e));
          setChats([]);
        },
      );
  }, [messageId]);
  const words = query.trim().toLowerCase();
  const titled = (chats ?? []).map((chat) => ({ chat, title: conversationTitle(chat, me?.id, t) }));
  const shown = words ? titled.filter((x) => x.title.toLowerCase().includes(words)) : titled;
  const send = async () => {
    if (!message) return;
    setSending(true);
    setProblem(null);
    const clientId = `${message.id.slice(0, 8)}-${Date.now()}`;
    try {
      const api = await client();
      const r = await patiently(() => api.messages.forward(message.id, chosen, clientId));
      onForwarded(r.messages);
      if (r.failed[0]) setProblem(r.failed[0].message);
      else onClose();
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setSending(false);
    }
  };
  return (
    <BottomSheet visible={!!message} title={t('chat.forwardTo')} onClose={onClose} gap={2}>
      <TextInput
        accessibilityLabel={t('chat.forwardSearch')}
        placeholder={t('chat.forwardSearch')}
        placeholderTextColor={c.inkMuted}
        value={query}
        onChangeText={setQuery}
        style={{ minHeight: 44, paddingHorizontal: space[3], borderRadius: radius.md, backgroundColor: c.surfaceSunken, color: c.ink }}
      />
      <ScrollView style={{ maxHeight: 340 }}>
        {chats && !shown.length ? <Text style={{ color: c.inkMuted, padding: space[2] }}>{t('chat.forwardEmpty')}</Text> : null}
        {shown.map(({ chat, title }) => {
          const on = chosen.includes(chat.id);
          const off = !on && chosen.length >= FORWARD_MAX_CHATS;
          const other = chat.members.find((m) => m.id !== me?.id);
          return (
            <Pressable
              key={chat.id}
              accessibilityRole="checkbox"
              accessibilityLabel={title}
              accessibilityState={{ checked: on, disabled: off }}
              disabled={off}
              onPress={() => setChosen((cur) => (on ? cur.filter((x) => x !== chat.id) : [...cur, chat.id]))}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], minHeight: 52, opacity: off ? 0.5 : 1 }}
            >
              <Avatar name={title} url={chat.members.length <= 2 ? other?.avatarUrl : undefined} size={36} />
              <Text numberOfLines={1} style={[{ flex: 1, color: c.ink, fontSize: 15, fontWeight: '600' }, userText]}>
                {title}
              </Text>
              <Icon name={on ? 'checkbox' : 'square-outline'} size={24} color={on ? c.yapi : c.inkMuted} />
            </Pressable>
          );
        })}
      </ScrollView>
      {problem ? <Text style={{ color: c.danger }}>{problem}</Text> : null}
      <Button
        label={chosen.length ? `${t('chat.forward')} (${chosen.length})` : t('chat.forward')}
        disabled={!chosen.length || sending}
        onPress={() => void send()}
      />
    </BottomSheet>
  );
}

/**
 * Reactions for one message, from the heart beside it: a row of your favourites (the emojis you
 * used lately, then the usual six) and +, which opens every emoji by kind with tabs, Recent first.
 * It stays open so you can add several; one you already gave is lit, and picking it again takes
 * it back. Done closes it.
 */
export function ReactionSheet({
  message,
  onClose,
  onToggle,
}: {
  message: Message | null;
  onClose: () => void;
  onToggle: (emoji: string, on: boolean) => void;
}) {
  const c = useColors();
  const { t } = useT();
  const recentOnes = useRecentReactions();
  const skinTone = useSkinTone();
  const [all, setAll] = useState(false);
  const [tab, setTab] = useState<string>('faces');
  const scroll = useRef<ScrollView>(null);
  const offsets = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!message) setAll(false);
  }, [message]);
  const mine = new Set(message?.reactions?.filter((r) => r.mine).map((r) => r.emoji));
  const toggle = (e: string) => {
    if (!mine.has(e)) noteReaction(e);
    onToggle(e, !mine.has(e));
  };
  const cell = (e: string) => (
    <Pressable
      key={e}
      accessibilityRole="button"
      accessibilityLabel={t('m.chat.reactWith', { emoji: e })}
      accessibilityState={{ selected: mine.has(e) }}
      onPress={() => toggle(e)}
      style={({ pressed }) => ({
        width: 46,
        height: 46,
        borderRadius: 23,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: mine.has(e) || pressed ? c.surfaceSunken : 'transparent',
        borderWidth: mine.has(e) ? 2 : 0,
        borderColor: c.yapi,
        transform: [{ scale: pressed ? 1.25 : 1 }],
      })}
    >
      <Text style={{ fontSize: 26 }}>{e}</Text>
    </Pressable>
  );
  const groups = [...(recentOnes.length ? [{ id: 'recent', emojis: recentOnes }] : []), ...REACTION_GROUPS].map((g) => ({
    id: g.id,
    emojis: inTone(g.emojis, skinTone),
  }));
  const header = (
    <View style={{ marginBottom: space[2], gap: space[2] }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        {favouriteReactions(recentOnes, skinTone).map(cell)}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('chat.reactMore')}
          accessibilityState={{ expanded: all }}
          onPress={() => setAll((v) => !v)}
          style={{ width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: c.surfaceSunken }}
        >
          <Icon name={all ? 'chevron-up' : 'add'} size={24} color={c.inkMuted} />
        </Pressable>
      </View>
      {all ? (
        <>
          <View accessibilityRole="radiogroup" accessibilityLabel={t('emoji.skinTone')}>
            <Text style={{ color: c.inkMuted, fontSize: 13, fontWeight: '600', marginBottom: space[1] }}>{t('emoji.skinTone')}</Text>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              {SKIN_TONES.map((option, i) => (
                <Pressable
                  key={option || 'yellow'}
                  accessibilityRole="radio"
                  accessibilityLabel={t(`emoji.tone${i}` as MessageKey)}
                  accessibilityState={{ selected: skinTone === option }}
                  onPress={() => chooseSkinTone(option)}
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: skinTone === option ? c.surfaceSunken : 'transparent',
                    borderWidth: skinTone === option ? 2 : 0,
                    borderColor: c.yapi,
                  }}
                >
                  <Text style={{ fontSize: 24 }}>{withTone('👋', option)}</Text>
                </Pressable>
              ))}
            </View>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 4 }}>
            {groups.map((g) => (
              <Pressable
                key={g.id}
                accessibilityRole="tab"
                accessibilityLabel={t(`emoji.${g.id}` as MessageKey)}
                accessibilityState={{ selected: tab === g.id }}
                onPress={() => {
                  setTab(g.id);
                  scroll.current?.scrollTo({ y: offsets.current[g.id] ?? 0, animated: true });
                }}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: tab === g.id ? c.surfaceSunken : 'transparent',
                }}
              >
                {g.id === 'recent' ? <Icon name="time-outline" size={20} color={c.inkMuted} /> : <Text style={{ fontSize: 20 }}>{g.emojis[0]}</Text>}
              </Pressable>
            ))}
          </ScrollView>
          <ScrollView ref={scroll} style={{ maxHeight: 340 }} nestedScrollEnabled>
            {groups.map((g) => (
              <View key={g.id} onLayout={(e) => (offsets.current[g.id] = e.nativeEvent.layout.y)}>
                <Text style={{ color: c.inkMuted, fontSize: 13, fontWeight: '600', marginTop: space[2], marginBottom: space[1] }}>
                  {t(`emoji.${g.id}` as MessageKey)}
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>{g.emojis.map(cell)}</View>
              </View>
            ))}
          </ScrollView>
        </>
      ) : null}
    </View>
  );
  return (
    <ActionSheet
      visible={!!message}
      onClose={onClose}
      title={t('chat.react')}
      header={header}
      actions={[{ label: t('m.common.done'), icon: 'checkmark', onPress: () => {} }]}
    />
  );
}

/** The long-press menu of a message: quick reactions, then actions. */
export function MessageActions({
  open,
  onClose,
  onReact,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  onReact?: (emoji: string) => void;
  actions: SheetAction[];
}) {
  const c = useColors();
  const { t } = useT();
  const skinTone = useSkinTone();
  const reactions = onReact ? (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: space[2] }}>
      {inTone(QUICK_REACTIONS, skinTone).map((e) => (
        <Pressable
          key={e}
          accessibilityRole="button"
          accessibilityLabel={t('m.chat.reactWith', { emoji: e })}
          onPress={() => onReact(e)}
          style={({ pressed }) => ({
            width: 48,
            height: 48,
            borderRadius: 24,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: pressed ? c.surfaceSunken : 'transparent',
          })}
        >
          <Text style={{ fontSize: 26 }}>{e}</Text>
        </Pressable>
      ))}
    </View>
  ) : null;
  return (
    <ActionSheet
      visible={open}
      onClose={onClose}
      title={t('m.chat.messageOptions')}
      header={reactions}
      actions={actions.map((a) => ({ label: a.label, icon: a.icon, destructive: a.danger, onPress: a.onPress }))}
    />
  );
}

/** Search the messages of one chat; tapping a result goes to it. */
export function SearchSheet({
  conversationId,
  open,
  onClose,
  onJump,
}: {
  conversationId: string;
  open: boolean;
  onClose: () => void;
  onJump: (id: string) => void;
}) {
  const focused = useScreenFocused();
  const c = useColors();
  const { t, dateTime } = useT();
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const text = q.trim();
    if (!text) {
      setResults(null);
      return;
    }
    const timer = setTimeout(() => {
      void client()
        .then((api) => api.conversations.search(conversationId, text))
        .then(
          (r) => {
            setResults(r.items);
            setError(null);
          },
          (e) => setError(errorMessage(e)),
        );
    }, 250);
    return () => clearTimeout(timer);
  }, [q, conversationId]);

  return (
    <Modal visible={open && focused} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: c.ground, paddingTop: insets.top + space[2] }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], paddingHorizontal: space[3], paddingBottom: space[2] }}>
          <TextInput
            autoFocus
            accessibilityLabel={t('m.chat.search')}
            placeholder={t('m.chat.search')}
            placeholderTextColor={c.inkMuted}
            value={q}
            onChangeText={setQ}
            maxLength={100}
            returnKeyType="search"
            style={[
              { flex: 1, height: 44, borderRadius: radius.full, paddingHorizontal: space[4], fontSize: 15, color: c.ink, backgroundColor: c.surface },
              userText,
            ]}
          />
          {/* 28pt wide so the side slop (8, the gap to the field) still makes 44. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('m.common.close')}
            hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
            onPress={onClose}
            style={{ minWidth: 28, alignItems: 'center' }}
          >
            <Icon name="close" size={26} color={c.ink} />
          </Pressable>
        </View>
        {error ? <Text style={{ color: c.danger, paddingHorizontal: space[4] }}>{error}</Text> : null}
        <FlatList
          data={results ?? []}
          keyExtractor={(m) => m.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: space[3], gap: space[1], paddingBottom: insets.bottom + space[4] }}
          ListEmptyComponent={results ? <Text style={{ color: c.inkMuted, textAlign: 'center', padding: space[4] }}>{t('m.chat.searchNone')}</Text> : null}
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              onPress={() => onJump(item.id)}
              style={({ pressed }) => ({ padding: space[3], borderRadius: radius.md, backgroundColor: pressed ? c.surfaceSunken : c.surface, gap: 2 })}
            >
              <Text style={[{ color: c.inkMuted, fontSize: 12 }, userText]}>
                {item.sender.displayName} · {dateTime(item.createdAt)}
              </Text>
              <Text style={[{ color: c.ink, fontSize: 15 }, userText]} numberOfLines={3}>
                {item.body}
              </Text>
            </Pressable>
          )}
        />
      </View>
    </Modal>
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
  onChange: (seconds: number | null) => void;
}) {
  const c = useColors();
  const { t } = useT();
  return (
    <BottomSheet visible={open} onClose={onClose} title={t('m.chat.disappearing')}>
      <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>{t('m.chat.disappearingHint')}</Text>
      {!canChange ? <Text style={{ color: c.inkMuted, fontSize: 14 }}>{t('m.chat.disappearingAdmins')}</Text> : null}
      <View accessibilityRole="radiogroup">
        {DISAPPEARING_OPTIONS.map((s) => {
          const on = (current ?? null) === s;
          return (
            <Pressable
              key={String(s)}
              accessibilityRole="radio"
              accessibilityState={{ checked: on, disabled: !canChange }}
              disabled={!canChange}
              onPress={() => onChange(s)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 48, opacity: canChange ? 1 : 0.5 }}
            >
              <Icon name={on ? 'radio-button-on' : 'radio-button-off'} size={22} color={on ? c.yapi : c.inkMuted} />
              <Text style={{ color: c.ink, fontSize: 16 }}>{disappearingText(t, s)}</Text>
            </Pressable>
          );
        })}
      </View>
    </BottomSheet>
  );
}
