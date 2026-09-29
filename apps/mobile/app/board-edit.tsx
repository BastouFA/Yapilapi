import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import { BOARD_DESCRIPTION_MAX, BOARD_NAME_MAX, BOARD_VISIBILITIES, type BoardVisibility } from '../../../packages/shared/src/constants';
import type { Board, Post } from '../../../packages/shared/src/types';
import { client, errorMessage, isGone, mediaUrl } from '../lib/api';
import { VISIBILITY_ICON } from '../lib/boards';
import { useT } from '../lib/i18n';
import { radius, space } from '../lib/theme';
import { Button, EmptyState, Field, Icon, KeyboardAvoid, Loading, Notice, ScreenError, useColors } from '../lib/ui';

/** Posts offered as a cover choice. */
const COVER_CHOICES = 12;

/**
 * Emoji in a description, as the API checks it. Built at run time: an engine without Unicode
 * property escapes just skips the check here, and the API still says so.
 */
const EMOJI = (() => {
  try {
    return new RegExp('[\\p{Extended_Pictographic}\\u{1F1E6}-\\u{1F1FF}]', 'u');
  } catch {
    return null;
  }
})();

/**
 * Start or edit a board (`?id=` to edit): name, description, who can see it and, for a board
 * with posts, its cover (one of them, or the first).
 */
export default function BoardEdit() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const c = useColors();
  const { t } = useT();
  const [board, setBoard] = useState<Board | null | undefined>(id ? undefined : null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<BoardVisibility>('private');
  const [cover, setCover] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Why the board couldn't load, when that isn't because it's gone or not yours to see.
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const api = await client();
      const [{ board: b }, page] = await Promise.all([api.boards.get(id), api.boards.items(id, 'all')]);
      setBoard(b);
      setPosts(page.items.slice(0, COVER_CHOICES));
      setName(b.name);
      setDescription(b.description);
      setVisibility(b.visibility);
      setCover(b.coverPostId ?? null);
      setLoadError(null);
    } catch (e) {
      if (isGone(e)) setBoard(null);
      else setLoadError(errorMessage(e));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (board === undefined) return loadError ? <ScreenError message={loadError} onRetry={load} /> : <Loading />;
  if (id && !board)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.boards.unavailable')} />
      </View>
    );
  const hasEmoji = !!EMOJI && EMOJI.test(description);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const api = await client();
      const base = { name: name.trim(), description: description.trim(), visibility };
      if (board) {
        await api.boards.update(board.id, { ...base, ...(cover !== (board.coverPostId ?? null) ? { coverPostId: cover } : {}) });
        router.back();
      } else {
        const r = await api.boards.create(base);
        router.replace(`/board/${r.board.id}`);
      }
    } catch (e) {
      // For example: people under 18 can't make a board public (the API says so).
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const hint: Record<BoardVisibility, string> = {
    private: t('m.boards.privateHint'),
    shared: t('m.boards.sharedHint'),
    public: t('m.boards.publicHint'),
  };

  const coverChoice = (key: string, on: boolean, label: string, onPress: () => void, uri: string | null) => (
    <Pressable
      key={key}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      accessibilityLabel={label}
      onPress={onPress}
      style={{ borderRadius: radius.md, borderWidth: 2, borderColor: on ? c.yapi : 'transparent', padding: 2 }}
    >
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: radius.sm,
          overflow: 'hidden',
          backgroundColor: c.yapiSoft,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {uri ? (
          <Image source={{ uri: mediaUrl(uri) }} style={{ width: 64, height: 64 }} />
        ) : (
          <Text style={{ color: c.ink, fontSize: 11, fontWeight: '700', textAlign: 'center', padding: 4 }} numberOfLines={3}>
            {label}
          </Text>
        )}
      </View>
    </Pressable>
  );

  return (
    <KeyboardAvoid>
      <ScrollView
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
        keyboardShouldPersistTaps="handled"
      >
        <Stack.Screen options={{ title: board ? t('m.boards.edit') : t('m.boards.new') }} />
        <Field label={t('m.boards.nameLabel')} value={name} onChangeText={setName} maxLength={BOARD_NAME_MAX} placeholder={t('m.boards.namePlaceholder')} />
        <View style={{ gap: space[1] }}>
          <Field
            label={t('m.boards.descriptionLabel')}
            value={description}
            onChangeText={setDescription}
            maxLength={BOARD_DESCRIPTION_MAX}
            multiline
            style={{ minHeight: 72, paddingTop: space[2], textAlignVertical: 'top' }}
          />
          <Text style={{ color: hasEmoji ? c.danger : c.inkMuted, fontSize: 12 }} accessibilityLiveRegion={hasEmoji ? 'polite' : undefined}>
            {hasEmoji ? t('m.boards.noEmoji') : t('m.boards.descriptionHint')}
          </Text>
        </View>

        <View style={{ gap: space[2] }}>
          <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.boards.visibilityLabel')}</Text>
          <View accessibilityRole="radiogroup" style={{ gap: space[2] }}>
            {BOARD_VISIBILITIES.map((v) => {
              const on = visibility === v;
              return (
                <Pressable
                  key={v}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`${t(`m.boards.visibility.${v}`)}. ${hint[v]}`}
                  onPress={() => setVisibility(v)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: space[3],
                    padding: space[3],
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: on ? c.yapi : c.line,
                    backgroundColor: on ? c.yapiSoft : c.surface,
                  }}
                >
                  <Icon name={VISIBILITY_ICON[v]} size={20} color={on ? c.yapi : c.inkMuted} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: c.ink, fontWeight: on ? '700' : '600' }}>{t(`m.boards.visibility.${v}`)}</Text>
                    <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{hint[v]}</Text>
                  </View>
                  <Icon name={on ? 'radio-button-on' : 'radio-button-off'} size={20} color={on ? c.yapi : c.lineStrong} />
                </Pressable>
              );
            })}
          </View>
        </View>

        {board && posts.length ? (
          <View style={{ gap: space[2] }}>
            <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.boards.cover')}</Text>
            <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
              {coverChoice('first', cover === null, t('m.boards.coverFirst'), () => setCover(null), null)}
              {posts.map((p, n) => {
                const image = p.media.find((m) => m.kind === 'image');
                const uri = p.locked ? null : image ? (image.variants?.thumb ?? image.url) : (p.media.find((m) => m.kind === 'video')?.posterUrl ?? null);
                return coverChoice(p.id, cover === p.id, t('m.boards.coverItem', { index: n + 1 }), () => setCover(p.id), uri);
              })}
            </View>
          </View>
        ) : null}

        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Button label={board ? t('common.save') : t('m.boards.create')} disabled={!name.trim() || busy || hasEmoji} onPress={() => save()} />
      </ScrollView>
    </KeyboardAvoid>
  );
}
