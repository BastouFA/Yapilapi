import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import type { MemorySummary } from '../../../packages/api-client/src/index';
import { client, errorMessage } from './api';
import { useT } from './i18n';
import { Sheet } from './post-edit';
import { radius, space } from './theme';
import { Button, Field, Icon, Notice, useColors, userText } from './ui';

/** "3 items · Private", "Shared", or "Shared with you" under a memory's name. */
export function useMemoryMeta() {
  const { t, tp } = useT();
  return (m: MemorySummary) =>
    `${tp('memories.items', m.itemCount)} · ${m.mine ? (m.visibility === 'private' ? t('memories.private') : t('memories.shared')) : t('memories.sharedWithYou')}`;
}

/**
 * "Add to a memory", from a post's More menu: your memories to pick from, or a new one made
 * right here. Only you add to your memories, and only posts you can see (the API checks both).
 */
export function AddToMemorySheet({ postId, onClose }: { postId: string | null; onClose: () => void }) {
  const c = useColors();
  const { t } = useT();
  const meta = useMemoryMeta();
  const [items, setItems] = useState<MemorySummary[] | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);

  useEffect(() => {
    if (!postId) return;
    let live = true;
    setItems(null);
    setAdded(new Set());
    setNote(null);
    setTitle('');
    client()
      .then((api) => api.memories.list())
      .then(
        (r) => live && setItems(r.items.filter((m) => m.mine)),
        (e) => {
          if (!live) return;
          setItems([]);
          setNote({ tone: 'danger', text: errorMessage(e) });
        },
      );
    return () => {
      live = false;
    };
  }, [postId]);

  async function add(m: MemorySummary) {
    if (!postId || busy) return;
    setBusy(m.id);
    setNote(null);
    try {
      await (await client()).memories.addItem(m.id, 'post', postId);
      setAdded((s) => new Set(s).add(m.id));
      setNote({ tone: 'info', text: t('m.mem.added', { title: m.title }) });
    } catch (e) {
      setNote({ tone: 'danger', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  async function createAndAdd() {
    const name = title.trim();
    if (!postId || !name || busy) return;
    setBusy('new');
    setNote(null);
    try {
      const api = await client();
      const { memory } = await api.memories.create({ title: name });
      await api.memories.addItem(memory.id, 'post', postId);
      setItems((cur) => [{ ...memory, itemCount: 1 }, ...(cur ?? [])]);
      setAdded((s) => new Set(s).add(memory.id));
      setTitle('');
      setNote({ tone: 'info', text: t('m.mem.added', { title: memory.title }) });
    } catch (e) {
      setNote({ tone: 'danger', text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Sheet visible={!!postId} title={t('m.mem.addTitle')} onClose={onClose}>
      {note ? <Notice tone={note.tone}>{note.text}</Notice> : null}
      {items === null ? (
        <ActivityIndicator color={c.yapi} accessibilityLabel={t('common.loading')} style={{ paddingVertical: space[4] }} />
      ) : items.length ? (
        <View style={{ gap: space[1] }}>
          {items.map((m) => {
            const done = added.has(m.id);
            return (
              <Pressable
                key={m.id}
                accessibilityRole="button"
                accessibilityLabel={`${m.title}, ${meta(m)}`}
                accessibilityState={{ disabled: done || !!busy, selected: done, busy: busy === m.id }}
                disabled={done || !!busy}
                onPress={() => void add(m)}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: space[3],
                  minHeight: 56,
                  paddingHorizontal: space[2],
                  borderRadius: radius.md,
                  backgroundColor: pressed ? c.surfaceSunken : 'transparent',
                })}
              >
                <Icon name="images-outline" size={22} color={c.yapi} />
                <View style={{ flex: 1 }}>
                  <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 15 }, userText]} numberOfLines={1}>
                    {m.title}
                  </Text>
                  <Text style={{ color: c.inkMuted, fontSize: 13 }} numberOfLines={1}>
                    {meta(m)}
                  </Text>
                </View>
                {busy === m.id ? (
                  <ActivityIndicator color={c.yapi} />
                ) : done ? (
                  <Icon name="checkmark-circle" size={22} color={c.yapi} />
                ) : (
                  <Icon name="add-circle-outline" size={22} color={c.inkMuted} />
                )}
              </Pressable>
            );
          })}
        </View>
      ) : (
        <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.mem.none')}</Text>
      )}
      <Field
        label={t('memories.new')}
        placeholder={t('memories.newPlaceholder')}
        value={title}
        onChangeText={setTitle}
        maxLength={120}
        returnKeyType="done"
        onSubmitEditing={() => void createAndAdd()}
      />
      <Button label={t('m.mem.createAndAdd')} variant="secondary" disabled={!title.trim() || !!busy} onPress={() => void createAndAdd()} />
      <Button label={t('m.common.done')} onPress={onClose} />
    </Sheet>
  );
}

/** "Make a recap video", with what it's made from and a Make one button. */
export function RecapCta({ hint, onPress }: { hint: string; onPress: () => void }) {
  const c = useColors();
  const { t } = useT();
  return (
    <View style={{ backgroundColor: c.yapiSoft, borderRadius: radius.lg, padding: space[3], gap: space[2] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
        <Icon name="film-outline" size={20} color={c.yapi} />
        <Text style={{ color: c.ink, fontWeight: '700', flex: 1 }}>{t('m.recap.make')}</Text>
      </View>
      <Text style={{ color: c.ink, lineHeight: 20 }}>{hint}</Text>
      <Button label={t('memories.makeOne')} icon="play" size="sm" variant="secondary" onPress={onPress} style={{ alignSelf: 'flex-start' }} />
    </View>
  );
}
