import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import type { EventItem } from '../../../../packages/shared/src/types';
import { TOGETHER_DESCRIPTION_MAX, TOGETHER_TITLE_MAX, type TogetherWindow } from '../../../../packages/shared/src/together';
import { client, errorMessage } from '../../lib/api';
import { useFlag } from '../../lib/flags';
import { FriendPicker, useFriends } from '../../lib/friend-picker';
import { useT } from '../../lib/i18n';
import { uploadPicked, type Picked } from '../../lib/media';
import { radius, space } from '../../lib/theme';
import { pickFromLibrary, WindowPicker, windowClosesAt } from '../../lib/together';
import { Button, Card, EmptyState, Field, Icon, KeyboardAvoid, Loading, Notice, SwitchRow, useColors, userText } from '../../lib/ui';

/**
 * Start an album: a name, a description, a cover, when it's open for adding, and who's in it:
 * friends (any of them a co-host), everyone in a chat (from the chat's menu, `?chat=`), or
 * everyone going to an event (`?event=`, or chosen here). Anyone else can ask to join with the
 * invite link.
 */
export default function NewTogether() {
  const c = useColors();
  const { t, tp } = useT();
  const on = useFlag('REAL_TOGETHER');
  const params = useLocalSearchParams<{ chat?: string; event?: string }>();
  const friends = useFriends();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [win, setWin] = useState<TogetherWindow>('weekend');
  const [custom, setCustom] = useState<Date | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [cohosts, setCohosts] = useState<Set<string>>(new Set());
  const [chatName, setChatName] = useState<string | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [eventId, setEventId] = useState(params.event ?? '');
  const [link, setLink] = useState(false);
  const [cover, setCover] = useState<Picked | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!on) return;
    void (async () => {
      const api = await client();
      if (params.chat)
        api.conversations.get(params.chat).then(
          (r) => setChatName(r.conversation.title || r.conversation.members.map((m) => m.displayName).join(', ')),
          () => setChatName(null),
        );
      const [a, b] = await Promise.all([api.events.list('hosting').catch(() => ({ items: [] })), api.events.list('going').catch(() => ({ items: [] }))]);
      const seen = new Set<string>();
      setEvents([...a.items, ...b.items].filter((e) => !seen.has(e.id) && seen.add(e.id)));
    })();
  }, [on, params.chat]);

  if (on === undefined) return <Loading />;
  if (!on)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('together.off')} />
      </View>
    );

  const closesAt = windowClosesAt(win, custom);
  const pickedFriends = (friends ?? []).filter((f) => picked.has(f.id));

  async function start() {
    if (!title.trim() || closesAt === undefined) return;
    setError(null);
    try {
      const api = await client();
      const r = await api.together.create({
        title: title.trim(),
        description: description.trim(),
        closesAt,
        memberIds: [...picked],
        cohostIds: [...cohosts].filter((x) => picked.has(x)),
        ...(params.chat ? { conversationId: params.chat } : {}),
        ...(eventId ? { eventId } : {}),
        inviteLink: link,
      });
      // The cover goes in the album as its first photo.
      if (cover) {
        try {
          const media = await uploadPicked(cover);
          const added = await api.together.addItems(r.together.id, [{ mediaId: media.id }]);
          if (added.items[0]) await api.together.update(r.together.id, { coverItemId: added.items[0].id });
        } catch {
          // The album is there; the cover can be chosen later.
        }
      }
      router.replace({ pathname: '/together/[id]', params: { id: r.together.id, ...(r.skipped ? { skipped: String(r.skipped) } : {}) } });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const chip = (id: string, label: string) => {
    const onNow = eventId === id;
    return (
      <Pressable
        key={id || 'none'}
        accessibilityRole="radio"
        accessibilityState={{ checked: onNow }}
        accessibilityLabel={label}
        onPress={() => setEventId(id)}
        style={{
          minHeight: 44,
          paddingHorizontal: space[3],
          borderRadius: radius.full,
          justifyContent: 'center',
          borderWidth: 1,
          borderColor: onNow ? c.ink : c.line,
          backgroundColor: onNow ? c.ink : c.surface,
        }}
      >
        <Text style={[{ color: onNow ? c.surface : c.ink, fontWeight: '600' }, userText]} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
    );
  };

  return (
    <KeyboardAvoid>
      <ScrollView
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
        keyboardShouldPersistTaps="handled"
      >
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Field
          label={t('together.create.name')}
          placeholder={t('together.create.namePlaceholder')}
          value={title}
          onChangeText={setTitle}
          maxLength={TOGETHER_TITLE_MAX}
        />
        <Field
          label={t('together.create.description')}
          placeholder={t('together.create.descriptionPlaceholder')}
          value={description}
          onChangeText={setDescription}
          maxLength={TOGETHER_DESCRIPTION_MAX}
          multiline
        />

        <View style={{ gap: space[2] }}>
          <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('together.create.cover')}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
            <View
              style={{
                width: 80,
                height: 80,
                borderRadius: radius.md,
                overflow: 'hidden',
                backgroundColor: c.yapiSoft,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {cover ? (
                <Image source={{ uri: cover.uri }} style={{ width: '100%', height: '100%' }} accessibilityIgnoresInvertColors />
              ) : (
                <Icon name="image-outline" size={28} color={c.yapi} />
              )}
            </View>
            <View style={{ flex: 1, gap: space[1] }}>
              <Button
                label={cover ? t('together.create.coverChange') : t('together.create.coverPick')}
                size="sm"
                variant="secondary"
                onPress={async () => {
                  const r = await pickFromLibrary();
                  if (r === 'denied') setError(t('together.add.denied'));
                  else if (r?.[0]) setCover(r[0]);
                }}
              />
              <Text style={{ color: c.inkMuted, fontSize: 12, lineHeight: 16 }}>{t('together.create.coverHint')}</Text>
            </View>
          </View>
        </View>

        <WindowPicker value={win} custom={custom} onChange={(w, d) => (setWin(w), setCustom(d))} />

        <Card style={{ gap: space[3] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 16 }}>
            {t('together.who.label')}
          </Text>
          {params.chat ? (
            <View
              style={{
                flexDirection: 'row',
                gap: space[2],
                alignItems: 'flex-start',
                backgroundColor: c.surfaceSunken,
                borderRadius: radius.md,
                padding: space[3],
              }}
            >
              <Icon name="people-outline" size={20} color={c.ink} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[{ color: c.ink, fontWeight: '700' }, userText]}>
                  {chatName ? t('together.who.chat', { name: chatName }) : t('together.who.chatSome')}
                </Text>
                <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('together.who.chatNote')}</Text>
              </View>
            </View>
          ) : null}
          <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('together.who.friends')}</Text>
          <FriendPicker friends={friends} picked={picked} onChange={setPicked} empty={t('together.who.noFriends')} />
          {pickedFriends.length ? (
            <View style={{ gap: space[2] }}>
              {pickedFriends.map((f) => (
                <SwitchRow
                  key={f.id}
                  label={`${f.displayName}: ${t('together.who.cohost')}`}
                  value={cohosts.has(f.id)}
                  onValueChange={(v) =>
                    setCohosts((s) => {
                      const n = new Set(s);
                      if (v) n.add(f.id);
                      else n.delete(f.id);
                      return n;
                    })
                  }
                />
              ))}
              <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('together.who.cohostHint')}</Text>
            </View>
          ) : null}
          <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('together.who.event')}</Text>
          <View accessibilityRole="radiogroup" accessibilityLabel={t('together.who.event')} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            {chip('', t('together.who.eventNone'))}
            {eventId && !events.some((e) => e.id === eventId) ? chip(eventId, t('together.who.eventThis')) : null}
            {events.map((e) => chip(e.id, e.title))}
          </View>
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('together.who.eventHint')}</Text>
        </Card>

        <SwitchRow label={t('together.link.label')} hint={t('together.link.hint')} value={link} onValueChange={setLink} />

        <Button label={t('together.create.submit')} icon="images-outline" disabled={!title.trim() || closesAt === undefined} onPress={() => start()} />
        {picked.size ? <Text style={{ color: c.inkMuted, fontSize: 13, textAlign: 'center' }}>{tp('together.people', picked.size + 1)}</Text> : null}
      </ScrollView>
    </KeyboardAvoid>
  );
}
