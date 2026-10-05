import { router } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { I18nManager, Image, Linking, PanResponder, Pressable, Text, TextInput, View, type LayoutChangeEvent } from 'react-native';
import type { Story } from '../../../packages/api-client/src/index';
import type { StoryCard, StorySticker, StoryStickerInput } from '../../../packages/shared/src/stories';
import { client, errorMessage, mediaUrl } from './api';
import { DateField } from './date-time';
import { useT, type Translator } from './i18n';
import { radius, space } from './theme';
import { Avatar, Button, Field, Icon, useColors, userText, type IconName } from './ui';

const INK = '#14151F';
const MUTED = '#4B4F63';
const ACCENT = '#D21D4A';
const CARD = '#FFFFFF';

/** Time left on a countdown, in the app's language. */
export function timeLeft(endsAt: string, t: Translator['t'], now = Date.now()): string {
  const ms = new Date(endsAt).getTime() - now;
  if (ms <= 0) return t('m.sticker.ended');
  const m = Math.floor(ms / 60_000);
  const days = Math.floor(m / 1440);
  const hours = Math.floor((m % 1440) / 60);
  if (days) return t('m.sticker.leftDays', { days, hours });
  if (hours) return t('m.sticker.leftHours', { hours, minutes: m % 60 });
  return t('m.sticker.leftMinutes', { minutes: Math.max(1, m) });
}

/**
 * A sticker centred on its point (relative to the frame, from the start edge and the top),
 * with its scale and rotation. It measures itself to centre.
 */
export function Placed({ x, y, scale = 1, rotation = 0, children }: { x: number; y: number; scale?: number; rotation?: number; children: ReactNode }) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width !== size.w || height !== size.h) setSize({ w: width, h: height });
  };
  return (
    <View
      onLayout={onLayout}
      style={{
        position: 'absolute',
        start: `${x * 100}%`,
        top: `${y * 100}%`,
        maxWidth: '82%',
        opacity: size.w ? 1 : 0,
        transform: [{ translateX: I18nManager.isRTL ? size.w / 2 : -size.w / 2 }, { translateY: -size.h / 2 }, { scale }, { rotate: `${rotation}deg` }],
      }}
    >
      {children}
    </View>
  );
}

function Chip({ icon, label, onPress, a11y }: { icon?: IconName; label: string; onPress: () => void; a11y: 'link' | 'button' }) {
  return (
    <Pressable
      accessibilityRole={a11y}
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: CARD,
        borderRadius: radius.full,
        paddingHorizontal: 14,
        paddingVertical: 8,
      }}
    >
      {icon ? <Icon name={icon} size={16} color={INK} /> : null}
      <Text style={[{ color: INK, fontWeight: '700', fontSize: 15 }, userText]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const cardBox = { backgroundColor: CARD, borderRadius: 16, padding: 12, gap: 8, width: 240, alignItems: 'stretch' } as const;
const titleText = { color: INK, fontWeight: '700', fontSize: 16, textAlign: 'center' } as const;
const metaText = { color: MUTED, fontSize: 13, textAlign: 'center' } as const;

/**
 * The stickers on a story, for viewers: mentions and tags open their pages, polls take one vote
 * and then show percentages, question boxes send an answer only the author sees, sliders take one
 * answer, countdowns offer "Remind me", links show their domain, places open the place page.
 * `onBusy` pauses the story while someone is answering.
 */
export function StickerLayer({
  story,
  mine,
  onChange,
  onBusy,
  onMessage,
}: {
  story: Story;
  mine: boolean;
  onChange: (stickers: StorySticker[]) => void;
  onBusy: (busy: boolean) => void;
  onMessage: (text: string) => void;
}) {
  const update = (id: string, patch: Partial<StorySticker>) => onChange(story.stickers.map((s) => (s.id === id ? ({ ...s, ...patch } as StorySticker) : s)));
  return (
    <>
      {story.stickers.map((s) => (
        <Placed key={s.id} x={s.x} y={s.y} scale={s.scale} rotation={s.rotation}>
          <Sticker story={story} s={s} mine={mine} update={update} onBusy={onBusy} onMessage={onMessage} />
        </Placed>
      ))}
    </>
  );
}

function Sticker({
  story,
  s,
  mine,
  update,
  onBusy,
  onMessage,
}: {
  story: Story;
  s: StorySticker;
  mine: boolean;
  update: (id: string, patch: Partial<StorySticker>) => void;
  onBusy: (busy: boolean) => void;
  onMessage: (text: string) => void;
}) {
  const { t, tp, number } = useT();
  const [text, setText] = useState('');
  const [value, setValue] = useState(s.type === 'slider' ? (s.mine ?? 0.5) : 0.5);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (s.type !== 'countdown') return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [s.type]);

  const run = async (f: () => Promise<void>) => {
    try {
      await f();
    } catch (e) {
      onMessage(errorMessage(e));
    }
  };

  switch (s.type) {
    case 'mention':
      return <Chip a11y="link" label={`@${s.user.username}`} onPress={() => router.push(`/u/${s.user.username}`)} />;
    case 'hashtag':
      return <Chip a11y="link" label={`#${s.tag}`} onPress={() => router.push(`/t/${encodeURIComponent(s.tag)}`)} />;
    case 'link':
      return <Chip a11y="link" icon="link" label={s.label ? `${s.label} · ${s.domain}` : s.domain} onPress={() => void Linking.openURL(s.url)} />;
    case 'place':
      return <Chip a11y="link" icon="location" label={s.name} onPress={() => router.push(`/place/${encodeURIComponent(s.placeId)}`)} />;
    case 'poll': {
      const shown = s.results !== undefined;
      return (
        <View style={cardBox} accessible={false}>
          {s.question ? <Text style={[titleText, userText]}>{s.question}</Text> : null}
          {s.options.map((o, i) => (
            <Pressable
              key={i}
              accessibilityRole="button"
              accessibilityLabel={shown ? `${o}, ${number((s.results![i] ?? 0) / 100, { style: 'percent' })}` : o}
              accessibilityState={{ selected: s.voted === i, disabled: mine || s.voted !== null }}
              disabled={mine || s.voted !== null}
              hitSlop={2}
              onPress={() =>
                void run(async () => {
                  const r = await (await client()).moments.vote(story.id, s.id, i as 0 | 1);
                  update(s.id, { voted: r.voted, results: r.results, votes: r.votes });
                })
              }
              style={{
                minHeight: 40,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: s.voted === i ? ACCENT : '#D9DBE6',
                backgroundColor: '#F4F5FA',
                overflow: 'hidden',
                justifyContent: 'center',
                paddingHorizontal: 12,
              }}
            >
              {shown ? (
                <View style={{ position: 'absolute', top: 0, bottom: 0, start: 0, width: `${s.results![i]}%`, backgroundColor: 'rgba(210,29,74,0.18)' }} />
              ) : null}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <Text style={[{ color: INK, fontWeight: '600', fontSize: 15, flexShrink: 1 }, userText]}>{o}</Text>
                {shown ? <Text style={{ color: INK, fontWeight: '700' }}>{number((s.results![i] ?? 0) / 100, { style: 'percent' })}</Text> : null}
              </View>
            </Pressable>
          ))}
          {shown ? <Text style={metaText}>{tp('m.sticker.votes', s.votes ?? 0)}</Text> : null}
        </View>
      );
    }
    case 'question':
      return (
        <View style={cardBox}>
          <Text style={[titleText, userText]}>{s.prompt}</Text>
          {mine ? (
            <Text style={metaText}>{t('m.sticker.answersInSeenBy')}</Text>
          ) : (
            <>
              <TextInput
                accessibilityLabel={s.prompt}
                placeholder={t('m.sticker.answerPlaceholder')}
                placeholderTextColor={MUTED}
                value={text}
                maxLength={300}
                onFocus={() => onBusy(true)}
                onBlur={() => onBusy(false)}
                onChangeText={setText}
                style={[
                  { height: 40, borderRadius: 12, borderWidth: 1, borderColor: '#D9DBE6', backgroundColor: '#F4F5FA', color: INK, paddingHorizontal: 12 },
                  userText,
                ]}
              />
              {text.trim() ? (
                <Pressable
                  accessibilityRole="button"
                  hitSlop={4}
                  onPress={() =>
                    void run(async () => {
                      const r = await (await client()).moments.answer(story.id, s.id, text.trim());
                      update(s.id, { answered: r.answered });
                      setText('');
                      onBusy(false);
                      onMessage(t('m.sticker.answerSent'));
                    })
                  }
                  style={{ height: 36, borderRadius: radius.full, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Text style={{ color: '#FFFFFF', fontWeight: '700' }}>{t('m.stories.send')}</Text>
                </Pressable>
              ) : s.answered ? (
                <Text style={metaText}>{t('m.sticker.answerSent')}</Text>
              ) : null}
            </>
          )}
        </View>
      );
    case 'slider': {
      const done = s.mine !== null;
      const shown = mine ? (s.average ?? 0) : value;
      return (
        <View style={cardBox}>
          <Text style={[titleText, userText]}>{s.prompt}</Text>
          <EmojiSlider
            emoji={s.emoji}
            label={s.prompt}
            value={shown}
            disabled={mine || done}
            onChange={setValue}
            onRelease={(v) =>
              void run(async () => {
                const r = await (await client()).moments.slide(story.id, s.id, v);
                update(s.id, { mine: r.mine });
              })
            }
          />
          <Text style={metaText}>
            {mine
              ? s.count
                ? t('m.sticker.average', { percent: number(s.average ?? 0, { style: 'percent' }), count: s.count })
                : t('m.sticker.noAnswers')
              : done
                ? t('m.sticker.answerSent')
                : t('m.sticker.slideHint')}
          </Text>
        </View>
      );
    }
    case 'countdown': {
      const ended = new Date(s.endsAt).getTime() <= now;
      return (
        <View style={cardBox}>
          <Text style={[titleText, userText]}>{s.title}</Text>
          <Text style={{ color: ACCENT, fontWeight: '800', fontSize: 22, textAlign: 'center' }}>{timeLeft(s.endsAt, t, now)}</Text>
          {!ended ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: s.reminding }}
              hitSlop={4}
              onPress={() =>
                void run(async () => {
                  const r = await (await client()).moments.remind(story.id, s.id, !s.reminding);
                  update(s.id, { reminding: r.reminding });
                })
              }
              style={{
                height: 36,
                borderRadius: radius.full,
                backgroundColor: s.reminding ? INK : ACCENT,
                flexDirection: 'row',
                gap: 6,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name={s.reminding ? 'notifications' : 'notifications-outline'} size={16} color="#FFFFFF" />
              <Text style={{ color: '#FFFFFF', fontWeight: '700' }}>{s.reminding ? t('m.sticker.reminderOn') : t('m.sticker.remindMe')}</Text>
            </Pressable>
          ) : null}
        </View>
      );
    }
  }
}

/** A track with an emoji handle: drag it and let go to answer. Screen readers adjust it in steps. */
function EmojiSlider({
  emoji,
  label,
  value,
  disabled,
  onChange,
  onRelease,
}: {
  emoji: string;
  label: string;
  value: number;
  disabled: boolean;
  onChange: (v: number) => void;
  onRelease: (v: number) => void;
}) {
  const width = useRef(1);
  const current = useRef(value);
  current.current = value;
  const state = useRef({ disabled, onChange, onRelease });
  state.current = { disabled, onChange, onRelease };
  const at = (x: number) => {
    const v = Math.min(1, Math.max(0, x / width.current));
    return I18nManager.isRTL ? 1 - v : v;
  };
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !state.current.disabled,
      onMoveShouldSetPanResponder: () => !state.current.disabled,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => state.current.onChange(at(e.nativeEvent.locationX)),
      onPanResponderMove: (e) => state.current.onChange(at(e.nativeEvent.locationX)),
      onPanResponderRelease: () => state.current.onRelease(current.current),
    }),
  ).current;
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}
      accessibilityState={{ disabled }}
      accessibilityActions={disabled ? [] : [{ name: 'increment' }, { name: 'decrement' }, { name: 'activate' }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'increment') onChange(Math.min(1, value + 0.1));
        else if (e.nativeEvent.actionName === 'decrement') onChange(Math.max(0, value - 0.1));
        else onRelease(value);
      }}
      onLayout={(e) => (width.current = Math.max(1, e.nativeEvent.layout.width))}
      hitSlop={{ top: 2, bottom: 2 }}
      style={{ height: 40, justifyContent: 'center' }}
      {...pan.panHandlers}
    >
      <View pointerEvents="none" style={{ height: 6, borderRadius: 3, backgroundColor: '#E4E6EF', overflow: 'hidden' }}>
        <View style={{ width: `${value * 100}%`, height: 6, backgroundColor: ACCENT }} />
      </View>
      <Text pointerEvents="none" style={{ position: 'absolute', start: `${value * 100}%`, marginStart: -13, fontSize: 24 }}>
        {emoji}
      </Text>
    </View>
  );
}

/**
 * A story inside something else (a message, a reshare). It opens only for people who can see the
 * story; for others it says it isn't available.
 */
export function StoryCardView({ card, label, action, dark }: { card: StoryCard; label?: string; action?: string; dark?: boolean }) {
  const c = useColors();
  const { t } = useT();
  const ink = dark ? '#FFFFFF' : c.ink;
  const muted = dark ? 'rgba(255,255,255,0.8)' : c.inkMuted;
  if (!card.available)
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2], paddingVertical: space[1] }}>
        <Icon name="eye-off-outline" size={18} color={muted} />
        <Text style={{ color: muted, fontSize: 14 }}>{t('m.stories.unavailable')}</Text>
      </View>
    );
  const preview = card.mediaKind === 'image' ? card.mediaUrl : card.mediaKind === 'video' ? card.posterUrl : null;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${label ?? `@${card.author.username}`}. ${action ?? t('m.stories.view')}`}
      onPress={() => router.push(`/s/${card.id}`)}
      style={{ flexDirection: 'row', gap: space[2], width: 230, maxWidth: '100%' }}
    >
      <View style={{ width: 64, height: 112, borderRadius: 10, overflow: 'hidden', backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center' }}>
        {preview ? (
          <Image source={{ uri: mediaUrl(preview) }} style={{ width: 64, height: 112 }} resizeMode="cover" />
        ) : (
          <Text style={[{ color: '#FFFFFF', fontSize: 11, fontWeight: '700', textAlign: 'center', padding: 4 }, userText]} numberOfLines={6}>
            {card.body}
          </Text>
        )}
      </View>
      <View style={{ flex: 1, justifyContent: 'center', gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Avatar name={card.author.displayName} url={card.author.avatarUrl} size={24} />
          <Text style={[{ color: ink, fontWeight: '700', fontSize: 14, flexShrink: 1 }, userText]} numberOfLines={1}>
            {label ?? `@${card.author.username}`}
          </Text>
        </View>
        {card.body && preview ? (
          <Text style={[{ color: muted, fontSize: 13 }, userText]} numberOfLines={2}>
            {card.body}
          </Text>
        ) : null}
        <Text style={{ color: dark ? '#FFFFFF' : c.yapi, fontWeight: '700', fontSize: 13 }}>{action ?? t('m.stories.view')}</Text>
      </View>
    </Pressable>
  );
}

// ── Placing stickers while creating a story ─────────────────────────────

/** A sticker being placed, with what to show for it before it's published. */
export type DraftSticker = StoryStickerInput & { key: string; label: string };
type Kind = StoryStickerInput['type'];
const INTERACTIVE: Kind[] = ['poll', 'question', 'slider', 'countdown', 'link'];
const KINDS: { type: Kind; icon: IconName }[] = [
  { type: 'mention', icon: 'at' },
  { type: 'hashtag', icon: 'pricetag-outline' },
  { type: 'poll', icon: 'stats-chart-outline' },
  { type: 'question', icon: 'help-circle-outline' },
  { type: 'slider', icon: 'options-outline' },
  { type: 'countdown', icon: 'timer-outline' },
  { type: 'link', icon: 'link' },
  { type: 'place', icon: 'location-outline' },
];
/** Shortcuts for when a countdown ends, shown in the date sheet. */
const ENDS = [
  { id: '1h', ms: 3_600_000, label: 'm.sticker.in.1h' },
  { id: '1d', ms: 86_400_000, label: 'm.sticker.in.1d' },
  { id: '3d', ms: 3 * 86_400_000, label: 'm.sticker.in.3d' },
  { id: '1w', ms: 7 * 86_400_000, label: 'm.sticker.in.1w' },
] as const;
/** The API takes a countdown end in the future and within 366 days (apps/api/src/lib/stories.ts). */
const COUNTDOWN_MIN_MS = 5 * 60_000;
const COUNTDOWN_MAX_MS = 365 * 86_400_000;
const clamp = (n: number) => Math.min(0.95, Math.max(0.05, n));

/**
 * Add a mention, hashtag, poll, question, emoji slider, countdown, link or place to a story, and
 * drag each into place on the preview. The server checks everything again.
 */
export function StickerEditor({
  stickers,
  onChange,
  preview,
  music,
  onMoveMusic,
}: {
  stickers: DraftSticker[];
  onChange: (s: DraftSticker[]) => void;
  preview: { uri?: string; kind?: string; body: string };
  /** The music sticker ("title · artist"), dragged into place like the others. */
  music?: { label: string; x: number; y: number } | null;
  onMoveMusic?: (x: number, y: number) => void;
}) {
  const c = useColors();
  const { t } = useT();
  const [adding, setAdding] = useState<Kind | null>(null);
  const frame = useRef({ w: 180, h: 320 });
  const latest = useRef(stickers);
  latest.current = stickers;
  const taken = (k: Kind) => INTERACTIVE.includes(k) && stickers.some((s) => s.type === k);

  return (
    <View style={{ gap: space[2] }}>
      <Text style={{ color: c.ink, fontWeight: '600' }}>{t('m.sticker.title')}</Text>
      <View
        onLayout={(e) => (frame.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
        style={{
          width: 180,
          aspectRatio: 9 / 16,
          borderRadius: radius.md,
          overflow: 'hidden',
          backgroundColor: ACCENT,
          alignSelf: 'center',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {preview.uri && preview.kind === 'image' ? (
          <Image source={{ uri: preview.uri }} style={{ position: 'absolute', width: '100%', height: '100%' }} resizeMode="cover" />
        ) : (
          <Text style={[{ color: '#FFFFFF', fontWeight: '800', fontSize: 15, textAlign: 'center', padding: space[3] }, userText]} numberOfLines={8}>
            {preview.body}
          </Text>
        )}
        {stickers.map((s) => (
          <Draggable
            key={s.key}
            sticker={s}
            frame={frame}
            label={t('m.sticker.drag', { label: s.label })}
            onMove={(x, y) => onChange(latest.current.map((d) => (d.key === s.key ? { ...d, x, y } : d)))}
          />
        ))}
        {music && onMoveMusic ? (
          <Draggable sticker={music} icon="musical-notes" frame={frame} label={t('m.sticker.drag', { label: music.label })} onMove={onMoveMusic} />
        ) : null}
      </View>
      {/* 34pt chips, rows 10 apart: 5 above and below reaches 44 without overlapping the next row. */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: space[2], rowGap: 10 }}>
        {KINDS.map((k) => (
          <Pressable
            key={k.type}
            hitSlop={{ top: 5, bottom: 5 }}
            accessibilityRole="button"
            accessibilityState={{ selected: adding === k.type, disabled: taken(k.type) || stickers.length >= 10 }}
            disabled={taken(k.type) || stickers.length >= 10}
            onPress={() => setAdding(adding === k.type ? null : k.type)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              height: 34,
              paddingHorizontal: 12,
              borderRadius: radius.full,
              borderWidth: 1,
              borderColor: adding === k.type ? c.yapi : c.line,
              backgroundColor: adding === k.type ? c.yapi : c.surface,
              opacity: taken(k.type) ? 0.45 : 1,
            }}
          >
            <Icon name={k.icon} size={16} color={adding === k.type ? c.onYapi : c.ink} />
            <Text style={{ color: adding === k.type ? c.onYapi : c.ink, fontWeight: '600', fontSize: 13 }}>{t(`m.sticker.kind.${k.type}`)}</Text>
          </Pressable>
        ))}
      </View>
      {adding ? (
        <StickerForm
          key={adding}
          kind={adding}
          onCancel={() => setAdding(null)}
          onAdd={(s) => {
            const offset = (stickers.length % 5) * 0.08;
            onChange([...stickers, { ...s, x: 0.5, y: clamp(0.3 + offset), key: `${Date.now()}-${stickers.length}` } as DraftSticker]);
            setAdding(null);
          }}
        />
      ) : null}
      {stickers.length ? (
        stickers.map((s) => (
          <View key={s.key} style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <Text style={[{ color: c.ink, flex: 1 }, userText]} numberOfLines={1}>
              {s.label}
            </Text>
            <Button label={t('m.common.remove')} variant="ghost" size="sm" onPress={() => onChange(stickers.filter((x) => x.key !== s.key))} />
          </View>
        ))
      ) : (
        <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.sticker.hint')}</Text>
      )}
    </View>
  );
}

function Draggable({
  sticker,
  icon,
  frame,
  label,
  onMove,
}: {
  sticker: { x: number; y: number; label: string };
  icon?: IconName;
  frame: { current: { w: number; h: number } };
  label: string;
  onMove: (x: number, y: number) => void;
}) {
  const start = useRef({ x: sticker.x, y: sticker.y });
  const pos = useRef({ x: sticker.x, y: sticker.y });
  pos.current = { x: sticker.x, y: sticker.y };
  const move = useRef(onMove);
  move.current = onMove;
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => (start.current = { ...pos.current }),
      onPanResponderMove: (_, g) => {
        const dx = (g.dx / frame.current.w) * (I18nManager.isRTL ? -1 : 1);
        move.current(clamp(start.current.x + dx), clamp(start.current.y + g.dy / frame.current.h));
      },
    }),
  ).current;
  return (
    <Placed x={sticker.x} y={sticker.y}>
      <View
        accessible
        accessibilityLabel={label}
        accessibilityRole="adjustable"
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => move.current(sticker.x, clamp(sticker.y + (e.nativeEvent.actionName === 'increment' ? 0.05 : -0.05)))}
        // About 28 tall; the touch area reaches 44.
        hitSlop={{ top: 9, bottom: 9, left: 4, right: 4 }}
        {...pan.panHandlers}
        style={{
          backgroundColor: CARD,
          borderRadius: radius.full,
          paddingHorizontal: 10,
          paddingVertical: 6,
          maxWidth: 160,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {icon ? <Icon name={icon} size={12} color={INK} /> : null}
        <Text style={[{ color: INK, fontWeight: '700', fontSize: 12, flexShrink: 1 }, userText]} numberOfLines={1}>
          {sticker.label}
        </Text>
      </View>
    </Placed>
  );
}

type NewSticker = StoryStickerInput & { label: string };

function StickerForm({ kind, onAdd, onCancel }: { kind: Kind; onAdd: (s: NewSticker) => void; onCancel: () => void }) {
  const c = useColors();
  const { t } = useT();
  const [a, setA] = useState(kind === 'question' ? t('m.sticker.askMe') : '');
  const [b, setB] = useState('');
  const [d, setD] = useState('');
  const [endsAt, setEndsAt] = useState<Date>(() => new Date(Date.now() + 86_400_000));
  const [error, setError] = useState<string | null>(null);
  const [places, setPlaces] = useState<{ id: string; name: string; city: string | null }[]>([]);

  useEffect(() => {
    if (kind !== 'place' || a.trim().length < 2) return setPlaces([]);
    const timer = setTimeout(() => {
      void client()
        .then((api) => api.search(a.trim(), 'places'))
        .then(
          (r) => setPlaces(((r.results.places as { id: string; name: string; city: string | null }[] | undefined) ?? []).slice(0, 6)),
          () => setPlaces([]),
        );
    }, 250);
    return () => clearTimeout(timer);
  }, [kind, a]);

  const base = { x: 0.5, y: 0.5 };
  const fail = () => setError(t('m.sticker.error'));
  const submit = () => {
    setError(null);
    switch (kind) {
      case 'mention': {
        const username = a.trim().replace(/^@/, '');
        if (!/^[a-z0-9_.]{3,30}$/i.test(username)) return fail();
        return onAdd({ type: 'mention', ...base, username, label: `@${username}` });
      }
      case 'hashtag': {
        const tag = a.trim().replace(/^#/, '');
        if (!/^[\p{L}\p{M}\p{N}_]{2,40}$/u.test(tag)) return setError(t('m.sticker.error.tag'));
        return onAdd({ type: 'hashtag', ...base, tag, label: `#${tag}` });
      }
      case 'poll':
        if (!b.trim() || !d.trim()) return fail();
        return onAdd({ type: 'poll', ...base, question: a.trim(), options: [b.trim(), d.trim()], label: a.trim() || `${b.trim()} / ${d.trim()}` });
      case 'question':
        if (!a.trim()) return fail();
        return onAdd({ type: 'question', ...base, prompt: a.trim(), label: a.trim() });
      case 'slider':
        if (!a.trim() || !b.trim()) return fail();
        return onAdd({ type: 'slider', ...base, prompt: a.trim(), emoji: b.trim(), label: `${b.trim()} ${a.trim()}` });
      case 'countdown': {
        if (!a.trim()) return fail();
        if (endsAt.getTime() <= Date.now()) return fail();
        return onAdd({ type: 'countdown', ...base, title: a.trim(), endsAt: endsAt.toISOString(), label: a.trim() });
      }
      case 'link': {
        const url = /^https?:\/\//i.test(a.trim()) ? a.trim() : `https://${a.trim()}`;
        let host = '';
        try {
          host = new URL(url).hostname.replace(/^www\./, '');
        } catch {
          host = '';
        }
        if (!host.includes('.')) return fail();
        return onAdd({ type: 'link', ...base, url, label: b.trim() || host });
      }
      case 'place':
        return fail();
    }
  };

  return (
    <View style={{ gap: space[2], padding: space[3], borderRadius: radius.md, borderWidth: 1, borderColor: c.line }}>
      {kind === 'mention' ? (
        <Field
          label={t('m.sticker.username')}
          value={a}
          onChangeText={setA}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('m.family.invite.placeholder')}
          maxLength={31}
        />
      ) : null}
      {kind === 'hashtag' ? (
        <Field label={t('m.sticker.kind.hashtag')} value={a} onChangeText={setA} autoCapitalize="none" placeholder="#tag" maxLength={41} />
      ) : null}
      {kind === 'poll' ? (
        <>
          <Field label={t('m.sticker.pollQuestion')} value={a} onChangeText={setA} maxLength={80} />
          <Field label={t('m.sticker.option', { number: 1 })} value={b} onChangeText={setB} maxLength={30} />
          <Field label={t('m.sticker.option', { number: 2 })} value={d} onChangeText={setD} maxLength={30} />
        </>
      ) : null}
      {kind === 'question' ? <Field label={t('m.sticker.prompt')} value={a} onChangeText={setA} maxLength={80} /> : null}
      {kind === 'slider' ? (
        <>
          <Field label={t('m.sticker.prompt')} value={a} onChangeText={setA} maxLength={80} />
          <Field label={t('m.sticker.emoji')} value={b} onChangeText={setB} maxLength={8} />
        </>
      ) : null}
      {kind === 'countdown' ? (
        <>
          <Field label={t('m.sticker.countdownTitle')} value={a} onChangeText={setA} maxLength={60} />
          <DateField
            label={t('m.sticker.endsAt')}
            sheetTitle={t('m.sticker.endsTitle')}
            value={endsAt}
            onChange={setEndsAt}
            min={new Date(Date.now() + COUNTDOWN_MIN_MS)}
            max={new Date(Date.now() + COUNTDOWN_MAX_MS)}
            presets={ENDS.map((e) => ({ id: e.id, label: t(e.label), at: new Date(Date.now() + e.ms) }))}
            hint={t('m.sticker.endsHint')}
          />
        </>
      ) : null}
      {kind === 'link' ? (
        <>
          <Field label={t('m.sticker.url')} value={a} onChangeText={setA} autoCapitalize="none" keyboardType="url" autoCorrect={false} maxLength={2000} />
          <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.sticker.linkHint')}</Text>
          <Field label={t('m.sticker.label')} value={b} onChangeText={setB} maxLength={40} />
        </>
      ) : null}
      {kind === 'place' ? (
        <>
          <Field label={t('m.sticker.findPlace')} value={a} onChangeText={setA} maxLength={100} />
          {places.map((p) => (
            <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
              <Icon name="location-outline" size={16} color={c.inkMuted} />
              <Text style={[{ color: c.ink, flex: 1 }, userText]} numberOfLines={1}>
                {p.name}
                {p.city ? ` · ${p.city}` : ''}
              </Text>
              <Button
                label={t('m.sticker.add')}
                size="sm"
                variant="secondary"
                onPress={() => onAdd({ type: 'place', ...base, placeId: p.id, label: p.name })}
              />
            </View>
          ))}
          {a.trim().length >= 2 && !places.length ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.sticker.noPlaces')}</Text> : null}
        </>
      ) : null}
      {error ? (
        <Text accessibilityLiveRegion="polite" style={{ color: c.danger, fontSize: 13 }}>
          {error}
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row', gap: space[2] }}>
        {kind !== 'place' ? <Button label={t('m.sticker.add')} size="sm" onPress={submit} /> : null}
        <Button label={t('common.cancel')} size="sm" variant="ghost" onPress={onCancel} />
      </View>
    </View>
  );
}
