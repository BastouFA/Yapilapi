// Chats: "Send later" (touch and hold the send button; the messages waiting show only to you at
// the end of the chat, with Edit, Send now and Cancel) and the chat's wallpaper and bubble colour.
// Same endpoints as the web app (components/ChatLater.tsx).
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert, Pressable, Text, View, type LayoutChangeEvent } from 'react-native';
import {
  ACCENTS,
  CHAT_ACCENTS,
  CHAT_WALLPAPERS,
  chatTheme,
  WALLPAPERS,
  type AccentColors,
  type ChatAccent,
  type ChatTheme,
  type ChatWallpaper,
} from '../../../packages/shared/src/chat-theme';
import { SCHEDULED_MESSAGE_MAX_DAYS } from '../../../packages/shared/src/constants';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import type { Message, ScheduledMessage } from '../../../packages/shared/src/types';
import { client, errorMessage } from './api';
import { DateTimeSheet } from './date-time';
import { useT } from './i18n';
import { useRealtime } from './session';
import { radius, space, type Palette } from './theme';
import { BottomSheet, Button, Field, Icon, useActionSheet, useColors, userText } from './ui';

/** Your messages waiting to be sent in this chat, kept current across your devices. */
export function useScheduled(conversationId: string) {
  const [items, setItems] = useState<ScheduledMessage[]>([]);
  const load = useCallback(async () => {
    try {
      setItems((await (await client()).conversations.scheduled(conversationId)).items);
    } catch {
      // The chat works without them; they load again on the next change.
    }
  }, [conversationId]);
  useEffect(() => {
    void load();
  }, [load]);
  useRealtime((e) => {
    if ((e.type === 'scheduled.updated' && e.data?.conversationId === conversationId) || e.type === 'app.foreground') void load();
  });
  return { items, setItems, reload: load };
}

/** The earliest and latest times a message can be sent later: two minutes to a year from now. */
export function laterLimits(now = Date.now()) {
  return { min: new Date(now + 2 * 60_000), max: new Date(now + SCHEDULED_MESSAGE_MAX_DAYS * 86_400_000) };
}

/** "Sends at 20:00" today, "Sends Sat 4 Oct at 20:00" another day. */
function useSendsLabel() {
  const { t, date, locale } = useT();
  return (iso: string) => {
    const at = new Date(iso);
    const now = new Date();
    const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(at);
    const sameDay = at.toDateString() === now.toDateString();
    if (sameDay) return t('m.chat.later.sendsAt', { time });
    const day = date(at, { weekday: 'short', day: 'numeric', month: 'short', ...(at.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
    return t('m.chat.later.sendsOn', { date: day, time });
  };
}

/**
 * The messages waiting to be sent, at the end of the chat on your side, faded, each with
 * "Sends at 20:00 · Edit · Send now · Cancel". One that couldn't be sent says why.
 */
export function ScheduledList({
  items,
  accent,
  onChanged,
  onSent,
  onRemoved,
  onError,
}: {
  items: ScheduledMessage[];
  accent: AccentColors;
  onChanged: (s: ScheduledMessage) => void;
  onSent: (s: ScheduledMessage, message: Message) => void;
  onRemoved: (s: ScheduledMessage) => void;
  onError: (message: string) => void;
}) {
  const c = useColors();
  const { t } = useT();
  const sendsLabel = useSendsLabel();
  const menu = useActionSheet();
  const [busy, setBusy] = useState<string | null>(null);
  const [editText, setEditText] = useState<ScheduledMessage | null>(null);
  const [editTime, setEditTime] = useState<ScheduledMessage | null>(null);
  const [text, setText] = useState('');
  if (!items.length && !editText && !editTime) return null;

  const run = async (s: ScheduledMessage, action: () => Promise<void>) => {
    setBusy(s.id);
    try {
      await action();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const edit = (s: ScheduledMessage) =>
    menu.show({
      title: t('m.chat.later.editTitle'),
      actions: [
        {
          label: t('m.chat.later.text'),
          icon: 'create-outline',
          onPress: () => {
            setText(s.body);
            setEditText(s);
          },
        },
        { label: t('m.chat.later.newTime'), icon: 'time-outline', onPress: () => setEditTime(s) },
      ],
    });
  const cancel = (s: ScheduledMessage) => {
    const go = () =>
      void run(s, async () => {
        await (await client()).scheduledMessages.cancel(s.id);
        onRemoved(s);
      });
    if (s.status === 'failed') return go();
    Alert.alert(t('m.chat.later.cancelConfirm'), undefined, [
      { text: t('m.chat.later.keep'), style: 'cancel' },
      { text: t('m.chat.later.cancelIt'), style: 'destructive', onPress: go },
    ]);
  };
  const limits = laterLimits();

  return (
    <View accessibilityLabel={t('m.chat.later.list')} style={{ gap: space[2], marginTop: space[2] }}>
      {items.map((s) => {
        const failed = s.status === 'failed';
        const action = (label: string, onPress: () => void) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: busy === s.id, busy: busy === s.id }}
            disabled={busy === s.id}
            // Small words in a row: the touch area reaches 44pt tall.
            hitSlop={{ top: 14, bottom: 14, left: 6, right: 6 }}
            onPress={onPress}
            style={{ opacity: busy === s.id ? 0.5 : 1 }}
          >
            <Text style={{ color: c.yapi, fontSize: 12, fontWeight: '800' }}>{label}</Text>
          </Pressable>
        );
        return (
          <View key={s.id} style={{ alignSelf: 'flex-end', maxWidth: '85%', alignItems: 'flex-end', gap: 4 }}>
            {/* Not sent yet: an outline in the chat's colour on the surface, so the text keeps full contrast. */}
            <View
              style={{
                borderRadius: 20,
                borderBottomEndRadius: 6,
                paddingHorizontal: 14,
                paddingVertical: 10,
                backgroundColor: c.surface,
                borderWidth: 1.5,
                borderStyle: 'dashed',
                borderColor: failed ? c.danger : accent.from,
              }}
            >
              <Text style={[{ color: c.ink, fontSize: 15, lineHeight: 21 }, userText]}>{s.body}</Text>
            </View>
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                justifyContent: 'flex-end',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 10,
                paddingVertical: 3,
                borderRadius: radius.full,
                backgroundColor: c.surface,
              }}
            >
              <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                <Icon name={failed ? 'alert-circle-outline' : 'time-outline'} size={13} color={failed ? c.danger : c.inkMuted} />
              </View>
              <Text style={{ color: failed ? c.danger : c.inkMuted, fontSize: 12 }}>
                {failed ? t('m.chat.later.failed', { reason: s.failure ?? '' }) : sendsLabel(s.sendAt)}
              </Text>
              <Dot color={c.inkMuted} />
              {failed ? action(t('m.chat.later.newTime'), () => setEditTime(s)) : action(t('m.chat.later.edit'), () => edit(s))}
              <Dot color={c.inkMuted} />
              {action(
                t('m.chat.later.sendNow'),
                () =>
                  void run(s, async () => {
                    const { message } = await (await client()).scheduledMessages.sendNow(s.id);
                    onSent(s, message);
                  }),
              )}
              <Dot color={c.inkMuted} />
              {action(failed ? t('m.chat.later.dismiss') : t('m.chat.later.cancel'), () => cancel(s))}
            </View>
          </View>
        );
      })}
      {menu.sheet}
      <BottomSheet visible={!!editText} title={t('m.chat.later.editTitle')} onClose={() => setEditText(null)}>
        <Field label={t('m.chat.later.text')} value={text} onChangeText={setText} multiline maxLength={4000} style={{ minHeight: 88 }} />
        <Button
          label={t('m.chat.later.save')}
          disabled={!text.trim()}
          onPress={async () => {
            const s = editText;
            if (!s) return;
            try {
              onChanged((await (await client()).scheduledMessages.edit(s.id, { body: text.trim() })).scheduled);
              setEditText(null);
            } catch (e) {
              onError(errorMessage(e));
            }
          }}
        />
      </BottomSheet>
      <DateTimeSheet
        visible={!!editTime}
        title={editTime?.status === 'failed' ? t('m.chat.later.newTime') : t('m.chat.later.title')}
        value={editTime && editTime.status === 'scheduled' ? new Date(editTime.sendAt) : null}
        min={limits.min}
        max={limits.max}
        quick
        hint={t('m.chat.later.hint')}
        confirmLabel={() => t('m.chat.later.save')}
        onClose={() => setEditTime(null)}
        onPick={(at) => {
          const s = editTime;
          setEditTime(null);
          if (!s) return;
          void run(s, async () => onChanged((await (await client()).scheduledMessages.edit(s.id, { sendAt: at.toISOString() })).scheduled));
        }}
      />
    </View>
  );
}

/** The dot between the actions under a waiting message: only a separator, so screen readers skip it. */
function Dot({ color }: { color: string }) {
  return (
    <Text accessibilityElementsHidden importantForAccessibility="no" style={{ color, fontSize: 12 }}>
      ·
    </Text>
  );
}

// ─── Wallpaper and bubble colour ────────────────────────────────────────

/** Your bubbles' colours in this chat for the app's appearance. */
export function accentFor(theme: ChatTheme | undefined, c: Palette): AccentColors {
  return ACCENTS[chatTheme(theme).accent][c.theme];
}

/**
 * A chat's wallpaper, drawn with plain views behind the messages: a soft gradient, or a flat tint
 * with dots, a grid or stripes. Nothing for "plain" (the app's own background shows).
 */
export function ChatWallpaperView({ wallpaper, radiusSize = 0 }: { wallpaper: ChatWallpaper; radiusSize?: number }) {
  const c = useColors();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const spec = WALLPAPERS[wallpaper];
  const colors = spec[c.theme];
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (Math.abs(width - size.w) > 1 || Math.abs(height - size.h) > 1) setSize({ w: width, h: height });
  };
  if (spec.kind === 'plain') return null;
  const fill = { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0, borderRadius: radiusSize, overflow: 'hidden' as const };
  if (spec.kind === 'gradient')
    return <LinearGradient pointerEvents="none" colors={[colors.from, colors.to]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={fill} />;
  const mark = colors.mark ?? colors.from;
  const step = spec.pattern === 'dots' ? 26 : spec.pattern === 'grid' ? 24 : 20;
  const cols = Math.ceil(size.w / step) + 1;
  const rows = Math.ceil(size.h / step) + 1;
  return (
    <View
      pointerEvents="none"
      onLayout={onLayout}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[fill, { backgroundColor: colors.from }]}
    >
      {spec.pattern === 'dots'
        ? Array.from({ length: rows }, (_, r) => (
            <View key={r} style={{ position: 'absolute', top: r * step + step / 2, left: r % 2 ? step / 2 : 0, flexDirection: 'row' }}>
              {Array.from({ length: cols }, (_, i) => (
                <View key={i} style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: mark, marginEnd: step - 4 }} />
              ))}
            </View>
          ))
        : null}
      {spec.pattern === 'grid' ? (
        <>
          {Array.from({ length: rows }, (_, r) => (
            <View key={`h${r}`} style={{ position: 'absolute', top: r * step, left: 0, right: 0, height: 1, backgroundColor: mark }} />
          ))}
          {Array.from({ length: cols }, (_, i) => (
            <View key={`v${i}`} style={{ position: 'absolute', left: i * step, top: 0, bottom: 0, width: 1, backgroundColor: mark }} />
          ))}
        </>
      ) : null}
      {spec.pattern === 'stripes' && size.w ? (
        // A square wide enough to cover the view at any angle, turned 45 degrees, with bands across it.
        <View
          style={{
            position: 'absolute',
            width: Math.hypot(size.w, size.h),
            height: Math.hypot(size.w, size.h),
            left: (size.w - Math.hypot(size.w, size.h)) / 2,
            top: (size.h - Math.hypot(size.w, size.h)) / 2,
            transform: [{ rotate: '45deg' }],
          }}
        >
          {Array.from({ length: Math.ceil(Math.hypot(size.w, size.h) / step) }, (_, i) => (
            <View key={i} style={{ position: 'absolute', top: i * step, left: 0, right: 0, height: 6, backgroundColor: mark }} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Pick the chat's wallpaper and bubble colour, with a preview. Changes apply for everyone right away. */
export function ChatLookSheet({
  visible,
  onClose,
  theme,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  theme: ChatTheme | undefined;
  onPick: (next: Partial<ChatTheme>) => Promise<void>;
}) {
  const c = useColors();
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const current = chatTheme(theme);
  const accent = accentFor(current, c);
  const pick = async (next: Partial<ChatTheme>) => {
    setBusy(true);
    try {
      await onPick(next);
    } finally {
      setBusy(false);
    }
  };
  const swatch = (selected: boolean, label: string, onPress: () => void, children: ReactNode) => (
    <Pressable
      key={label}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected, disabled: busy }}
      disabled={busy}
      onPress={onPress}
      style={{
        width: 84,
        alignItems: 'center',
        gap: 4,
        padding: 4,
        borderRadius: radius.md,
        borderWidth: 2,
        borderColor: selected ? c.yapi : 'transparent',
        backgroundColor: selected ? c.yapiSoft : 'transparent',
      }}
    >
      {children}
      <Text style={{ color: c.ink, fontSize: 12, fontWeight: '600' }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
  return (
    <BottomSheet visible={visible} title={t('m.chat.look.title')} subtitle={t('m.chat.look.desc')} onClose={onClose} done>
      {/* Preview: their bubble on the surface, yours in the chosen colour, on the chosen wallpaper. */}
      <View
        accessibilityLabel={t('m.chat.look.preview')}
        style={{
          gap: space[2],
          padding: space[3],
          borderRadius: radius.lg,
          overflow: 'hidden',
          backgroundColor: c.ground,
          borderWidth: 1,
          borderColor: c.line,
        }}
      >
        <ChatWallpaperView wallpaper={current.wallpaper} radiusSize={radius.lg} />
        <View
          style={{
            alignSelf: 'flex-start',
            backgroundColor: c.surface,
            borderRadius: 18,
            borderBottomStartRadius: 6,
            paddingHorizontal: 12,
            paddingVertical: 8,
          }}
        >
          <Text style={{ color: c.ink, fontSize: 14 }}>{t('m.chat.look.sampleThem')}</Text>
        </View>
        <LinearGradient
          colors={[accent.from, accent.to]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ alignSelf: 'flex-end', borderRadius: 18, borderBottomEndRadius: 6, paddingHorizontal: 12, paddingVertical: 8 }}
        >
          <Text style={{ color: accent.on, fontSize: 14 }}>{t('m.chat.look.sampleMe')}</Text>
        </LinearGradient>
      </View>
      <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 15, fontWeight: '800' }}>
        {t('m.chat.look.wallpaper')}
      </Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={t('m.chat.look.wallpaper')} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        {CHAT_WALLPAPERS.map((w) =>
          swatch(
            current.wallpaper === w,
            t(`m.chat.wallpaper.${w}` as MessageKey),
            () => current.wallpaper !== w && void pick({ wallpaper: w }),
            <View
              style={{ width: 72, height: 48, borderRadius: radius.sm, overflow: 'hidden', backgroundColor: c.ground, borderWidth: 1, borderColor: c.line }}
            >
              <ChatWallpaperView wallpaper={w} />
            </View>,
          ),
        )}
      </View>
      <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 15, fontWeight: '800' }}>
        {t('m.chat.look.colour')}
      </Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={t('m.chat.look.colour')} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        {CHAT_ACCENTS.map((a: ChatAccent) => {
          const colors = ACCENTS[a][c.theme];
          return swatch(
            current.accent === a,
            t(`m.chat.accent.${a}` as MessageKey),
            () => current.accent !== a && void pick({ accent: a }),
            <LinearGradient
              colors={[colors.from, colors.to]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{ width: 40, height: 40, borderRadius: 20 }}
            />,
          );
        })}
      </View>
    </BottomSheet>
  );
}
