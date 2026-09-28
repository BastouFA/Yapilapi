import { router } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, FlatList, I18nManager, Modal, PanResponder, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Message, MessagePreview, PinnedMessage } from '../../../packages/shared/src/types';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import { chatTheme } from '../../../packages/shared/src/chat-theme';
import { chessDrawReason } from '../../../packages/shared/src/games/index';
import { messagePreviewOf, messagePreviewText } from '../../../packages/shared/src/message-preview';
import { client, errorMessage } from './api';
import { useT } from './i18n';
import { useSession } from './session';
import { radius, space } from './theme';
import { ActionSheet, BottomSheet, Button, Icon, useColors, userText, useScreenFocused } from './ui';
import { openWatch } from './watch';

/**
 * Chat extras: quoted replies, reactions, pinned messages, search, disappearing
 * messages and the long-press menu. Used by app/chat/[id].tsx.
 */

/** Quick reactions offered on every message. */
export const QUICK_REACTIONS = ['❤️', '😂', '😮', '😢', '👍', '🙏'] as const;
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
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, alignSelf: mine ? 'flex-end' : 'flex-start', marginTop: -2 }}>
      {message.reactions.map((r) => (
        <Pressable
          key={r.emoji}
          accessibilityRole="button"
          accessibilityState={{ selected: r.mine }}
          accessibilityLabel={t('m.chat.reactionA11y', { emoji: r.emoji, count: r.count })}
          onPress={() => onToggle(r.emoji, !r.mine)}
          // 28pt tall; the touch area still reaches 44pt.
          hitSlop={8}
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
  const { t, tp } = useT();
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
  if (s?.type === 'watch') {
    const text = message.sender.id === meId ? t('watch.system.startedYou') : t('watch.system.started', { name: message.sender.displayName });
    return (
      <View style={{ alignSelf: 'center', alignItems: 'center', gap: space[1], maxWidth: '90%', paddingVertical: space[1] }}>
        <View style={{ flexDirection: 'row', gap: space[1], alignItems: 'center' }}>
          <Icon name="tv-outline" size={14} color={c.inkMuted} />
          <Text style={[{ color: c.inkMuted, fontSize: 13, textAlign: 'center', lineHeight: 18 }, userText]}>{text}</Text>
        </View>
        {watchLive ? <Button label={t('watch.join')} size="sm" variant="secondary" icon="play" onPress={() => openWatch(s.sessionId)} /> : null}
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
          hitSlop={10}
          onPress={() => onUnpin(pin.message.id)}
          style={{ padding: space[1] }}
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
  const reactions = onReact ? (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: space[2] }}>
      {QUICK_REACTIONS.map((e) => (
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
          <Pressable accessibilityRole="button" accessibilityLabel={t('m.common.close')} hitSlop={10} onPress={onClose}>
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
