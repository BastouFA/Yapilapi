import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SCHEDULE_MAX_DAYS, SCHEDULE_MIN_MINUTES } from '../../../packages/shared/src/constants';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import type { Post, PostVersion } from '../../../packages/shared/src/types';
import { client, errorMessage } from './api';
import { DateTimeSheet } from './date-time';
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

/**
 * Pick when a post or reel goes out: between SCHEDULE_MIN_MINUTES and SCHEDULE_MAX_DAYS from now,
 * on the calendar and clock, with In 1 hour, Tonight and Tomorrow morning as shortcuts.
 */
export function SchedulePicker({
  visible,
  value,
  onClose,
  onPick,
}: {
  visible: boolean;
  value?: Date | null;
  onClose: () => void;
  onPick: (at: Date) => void;
}) {
  const { t, dateTime } = useT();
  const now = Date.now();
  return (
    <DateTimeSheet
      visible={visible}
      title={t('m.schedule.title')}
      value={value ?? new Date(now + 60 * 60_000)}
      min={new Date(now + SCHEDULE_MIN_MINUTES * 60_000)}
      max={new Date(now + SCHEDULE_MAX_DAYS * 86_400_000)}
      quick
      hint={t('m.schedule.customHint')}
      confirmLabel={(at) => t('m.schedule.confirm', { time: dateTime(at) })}
      onClose={onClose}
      onPick={onPick}
    />
  );
}
