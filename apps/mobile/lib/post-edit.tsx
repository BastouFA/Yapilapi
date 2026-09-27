import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SCHEDULE_MAX_DAYS, SCHEDULE_MIN_MINUTES } from '../../../packages/shared/src/constants';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import type { Post, PostVersion } from '../../../packages/shared/src/types';
import { client, errorMessage } from './api';
import { useT } from './i18n';
import { RichText } from './rich-text';
import { radius, space } from './theme';
import { Button, Field, Notice, Segmented, useColors, userText } from './ui';

/** A panel that slides up from the bottom, over a dimmed screen; tapping outside closes it. */
export function Sheet({ visible, title, onClose, children }: { visible: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const c = useColors();
  const { t } = useT();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' }}>
          <Pressable accessibilityRole="button" accessibilityLabel={t('m.common.close')} style={{ flex: 1 }} onPress={onClose} />
          <View
            accessibilityViewIsModal
            style={{
              backgroundColor: c.surface,
              borderTopLeftRadius: radius.lg,
              borderTopRightRadius: radius.lg,
              padding: space[4],
              paddingBottom: Math.max(insets.bottom, space[4]),
              maxHeight: '85%',
              gap: space[3],
            }}
          >
            <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
              {title}
            </Text>
            <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ gap: space[3] }} keyboardShouldPersistTaps="handled">
              {children}
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const EDIT_AUDIENCES = [
  { id: 'public', label: 'visibility.public' },
  { id: 'followers', label: 'visibility.followers' },
  { id: 'friends', label: 'visibility.friends' },
  { id: 'private', label: 'visibility.private' },
] as const satisfies readonly { id: string; label: MessageKey }[];

/**
 * Change your post: its text, who can see it, and the description of its photo
 * or video. Earlier text stays in the post's history.
 */
export function EditPostSheet({ post, onClose, onSaved }: { post: Post; onClose: () => void; onSaved: (p: Post) => void }) {
  const c = useColors();
  const { t } = useT();
  const [body, setBody] = useState(post.body);
  const [visibility, setVisibility] = useState<string>(post.visibility);
  const described = post.media.filter((m) => m.kind !== 'audio');
  const [alts, setAlts] = useState<Record<string, string>>(() => Object.fromEntries(described.map((m) => [m.id, m.altText ?? ''])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Circles, chosen people and subscribers stay as they are; the others can be picked.
  const audiences = EDIT_AUDIENCES.some((a) => a.id === post.visibility)
    ? EDIT_AUDIENCES
    : [...EDIT_AUDIENCES, { id: post.visibility, label: `visibility.${post.visibility}` as MessageKey }];
  const changedAlts = described.filter((m) => (alts[m.id] ?? '') !== (m.altText ?? ''));
  const changed = body.trim() !== post.body || visibility !== post.visibility || changedAlts.length > 0;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await (
        await client()
      ).posts.edit(post.id, {
        ...(body.trim() !== post.body ? { body: body.trim() } : {}),
        ...(visibility !== post.visibility ? { visibility: visibility as 'public' } : {}),
        ...(changedAlts.length ? { media: changedAlts.map((m) => ({ id: m.id, altText: (alts[m.id] ?? '').trim() })) } : {}),
      });
      onSaved(r.post);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible title={t('m.post.editTitle')} onClose={onClose}>
      <Field
        label={t('m.post.text')}
        value={body}
        onChangeText={setBody}
        multiline
        maxLength={post.format === 'reel' ? 2200 : 5000}
        style={{ minHeight: 120, textAlignVertical: 'top', paddingTop: 12 }}
      />
      {described.map((m) => (
        <Field
          key={m.id}
          label={t('m.create.altText')}
          placeholder={t('m.create.altTextPlaceholder')}
          value={alts[m.id] ?? ''}
          onChangeText={(v) => setAlts((cur) => ({ ...cur, [m.id]: v }))}
          maxLength={500}
        />
      ))}
      {post.community ? null : (
        <>
          <Text style={{ color: c.ink, fontWeight: '600' }}>{t('create.visibility')}</Text>
          <Segmented
            label={t('create.visibility')}
            options={audiences.map((a) => ({ id: a.id, label: t(a.label) }))}
            value={visibility}
            onChange={setVisibility}
          />
        </>
      )}
      <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.post.editNote')}</Text>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button label={t('m.post.saveChanges')} disabled={!changed || busy} onPress={() => void save()} />
    </Sheet>
  );
}

/** The versions of an edited post's text, newest first. */
export function HistorySheet({ postId, onClose }: { postId: string; onClose: () => void }) {
  const c = useColors();
  const { t, timeAgo } = useT();
  const [items, setItems] = useState<PostVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    client()
      .then((api) => api.posts.history(postId))
      .then(
        (r) => setItems(r.items),
        (e) => setError(errorMessage(e)),
      );
  }, [postId]);
  return (
    <Sheet visible title={t('m.post.history')} onClose={onClose}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {items === null && !error ? <ActivityIndicator color={c.yapi} /> : null}
      {(items ?? []).map((v, i) => (
        <View key={`${v.at}-${i}`} style={{ gap: space[1], paddingBottom: space[3], borderBottomWidth: i < items!.length - 1 ? 1 : 0, borderColor: c.line }}>
          <Text style={{ color: c.inkMuted, fontSize: 12 }}>
            {v.current ? t('m.post.historyNow') : t('m.post.historyEarlier')} · {timeAgo(v.at)}
          </Text>
          {v.body ? (
            <RichText text={v.body} style={{ color: c.ink, fontSize: 15, lineHeight: 22 }} />
          ) : (
            <Text style={[{ color: c.inkMuted }, userText]}>{t('m.post.noText')}</Text>
          )}
        </View>
      ))}
    </Sheet>
  );
}

/** The quick choices for when a scheduled post goes out; ones already too close are left out. */
export function schedulePresets(now = new Date()): { id: string; label: MessageKey; at: Date }[] {
  const inHour = new Date(now.getTime() + 60 * 60_000);
  const tonight = new Date(now);
  tonight.setHours(20, 0, 0, 0);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const soonest = now.getTime() + SCHEDULE_MIN_MINUTES * 60_000;
  return [
    { id: 'hour', label: 'm.schedule.inHour' as const, at: inHour },
    { id: 'tonight', label: 'm.schedule.tonight' as const, at: tonight },
    { id: 'tomorrow', label: 'm.schedule.tomorrow' as const, at: tomorrow },
  ].filter((p) => p.at.getTime() >= soonest);
}

/** "2026-10-06 20:00" (or with a T) as a time on this phone's clock, or null when it isn't one. */
export function parseLocalTime(text: string): Date | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const at = new Date(y, mo - 1, d, h, mi);
  return at.getFullYear() === y && at.getMonth() === mo - 1 && at.getDate() === d && at.getHours() === h && at.getMinutes() === mi ? at : null;
}

/** Whether a time is in the window a post can be scheduled for. */
export const schedulable = (at: Date, now = Date.now()) =>
  at.getTime() >= now + SCHEDULE_MIN_MINUTES * 60_000 && at.getTime() <= now + SCHEDULE_MAX_DAYS * 86_400_000;

/**
 * Pick when a post goes out: in an hour, tonight at 8 pm, tomorrow at 9 am, or
 * a typed date and time (there's no date picker in the app).
 */
export function SchedulePicker({ visible, onClose, onPick }: { visible: boolean; onClose: () => void; onPick: (at: Date) => void }) {
  const c = useColors();
  const { t, dateTime } = useT();
  const [custom, setCustom] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const opened = useRef(Date.now());
  useEffect(() => {
    if (!visible) return;
    opened.current = Date.now();
    setCustom(false);
    setError(null);
  }, [visible]);
  const typed = parseLocalTime(text);
  return (
    <Sheet visible={visible} title={t('m.schedule.title')} onClose={onClose}>
      {schedulePresets(new Date(opened.current)).map((p) => (
        <Button key={p.id} label={`${t(p.label)} · ${dateTime(p.at)}`} variant="secondary" onPress={() => onPick(p.at)} />
      ))}
      {custom ? (
        <>
          <Field
            label={t('m.schedule.customLabel')}
            value={text}
            onChangeText={(v) => {
              setText(v);
              setError(null);
            }}
            placeholder="2026-10-06 20:00"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="numbers-and-punctuation"
          />
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.schedule.customHint')}</Text>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Button
            label={typed ? t('m.schedule.confirm', { time: dateTime(typed) }) : t('m.create.schedule')}
            disabled={!text.trim()}
            onPress={() => {
              if (!typed) return setError(t('m.schedule.invalid'));
              if (!schedulable(typed)) return setError(t('m.schedule.customHint'));
              onPick(typed);
            }}
          />
        </>
      ) : (
        <Button label={t('m.schedule.custom')} variant="ghost" onPress={() => setCustom(true)} />
      )}
    </Sheet>
  );
}
