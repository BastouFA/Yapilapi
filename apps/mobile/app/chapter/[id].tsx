import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Image, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { ChapterDetail, GuestbookEntry } from '../../../../packages/api-client/src/index';
import { CHAPTER_GUESTBOOK_MAX } from '../../../../packages/shared/src/constants';
import type { PublicUser } from '../../../../packages/shared/src/types';
import { client, errorMessage, isGone, mediaUrl } from '../../lib/api';
import { ChapterCover, ChapterPlayer, isSealed, useChapterMeta } from '../../lib/chapters';
import { useT } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { radius, space } from '../../lib/theme';
import { Avatar, Button, Card, EmptyState, Field, KeyboardAvoid, Loading, Notice, ScreenError, SwitchRow, Title, useColors, userText } from '../../lib/ui';

/**
 * A chapter: cover, audience, stories credited to whoever shared each one, the people adding to
 * it and the guestbook. The owner edits, invites, seals a time capsule and removes stories,
 * people or lines; contributors add from their archive, leave, and choose whether it also shows
 * on their profile.
 */
export default function ChapterScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, date, timeAgo } = useT();
  const { me } = useSession();
  const meta = useChapterMeta();
  const [data, setData] = useState<ChapterDetail | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [guestbook, setGuestbook] = useState<GuestbookEntry[]>([]);
  const [line, setLine] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [playing, setPlaying] = useState<number | null>(null);
  const [inviting, setInviting] = useState(false);

  const load = useCallback(async () => {
    try {
      const api = await client();
      setData(await api.chapters.get(id));
      setLoadError(null);
      setGuestbook((await api.chapters.guestbook(id).catch(() => ({ items: [] as GuestbookEntry[] }))).items);
    } catch (e) {
      if (isGone(e)) setData(null);
      else setLoadError(errorMessage(e));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (data === undefined) return loadError ? <ScreenError message={loadError} onRetry={load} /> : <Loading />;
  if (data === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground }}>
        <EmptyState title={t('m.chapters.unavailable')} />
      </View>
    );

  const { chapter, stories, contributors } = data;
  const owner = chapter.role === 'owner';
  const sealed = isSealed(chapter);
  const act = (fn: () => Promise<unknown>, done?: string) => async () => {
    setNote(null);
    try {
      await fn();
      if (done) setNote(done);
      await load();
    } catch (e) {
      setNote(errorMessage(e));
    }
  };
  const api = () => client().then((a) => a.chapters);

  return (
    <>
      {/* The guestbook line is typed below the stories: the keyboard makes room instead of covering it. */}
      <KeyboardAvoid style={{ backgroundColor: c.ground }}>
        <ScrollView
          style={{ backgroundColor: c.ground }}
          contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ flexDirection: 'row', gap: space[4], alignItems: 'center' }}>
            <ChapterCover chapter={chapter} size={96} />
            <View style={{ flex: 1, gap: 4 }}>
              <Title sub={`${chapter.owner.displayName} · ${meta(chapter)}`}>{chapter.title}</Title>
              <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t(`m.chapters.audience.${chapter.audience}`)}</Text>
            </View>
          </View>
          {chapter.description ? <Text style={[{ color: c.ink, lineHeight: 21 }, userText]}>{chapter.description}</Text> : null}
          {note ? <Notice>{note}</Notice> : null}

          {sealed ? (
            <Card style={{ gap: space[2] }}>
              <Text style={{ color: c.ink, fontWeight: '700' }}>
                {t('m.chapters.sealedUntil', { date: date(chapter.capsule!.opensAt, { dateStyle: 'long' }) })}
              </Text>
              <Text style={{ color: c.inkMuted, lineHeight: 20 }}>
                {chapter.capsule!.sealed ? t('m.chapters.addingClosed') : t('m.chapters.addingOpen')} {t('m.chapters.sealedBody')}
              </Text>
              {owner && !chapter.capsule!.sealed ? (
                <Button
                  size="sm"
                  variant="secondary"
                  label={t('m.chapters.seal')}
                  disabled={!chapter.storyCount}
                  onPress={act(async () => (await api()).seal(chapter.id))}
                />
              ) : null}
            </Card>
          ) : null}

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            {stories.length && !sealed ? <Button icon="play" label={t('m.chapters.play')} onPress={() => setPlaying(0)} /> : null}
            {chapter.role === 'invited' ? (
              <>
                <Button label={t('m.chapters.join')} onPress={act(async () => (await api()).join(chapter.id))} />
                <Button variant="ghost" label={t('m.chapters.decline')} onPress={act(async () => (await api()).removeContributor(chapter.id, me!.id))} />
              </>
            ) : null}
            {chapter.canAdd ? <Button variant="secondary" label={t('m.chapters.addFromArchive')} onPress={() => router.push('/archive')} /> : null}
            {owner ? (
              <>
                <Button variant="secondary" label={t('m.chapters.edit')} onPress={() => router.push(`/chapter-edit?id=${chapter.id}`)} />
                {stories.length && !sealed ? (
                  <Button
                    variant="secondary"
                    icon="film-outline"
                    label={t('m.recap.make')}
                    onPress={() => router.push({ pathname: '/recap-new', params: { source: 'chapter', sourceId: chapter.id } })}
                  />
                ) : null}
                {chapter.canAdd ? (
                  <Button variant="secondary" icon="people-outline" label={t('m.chapters.invite')} onPress={() => setInviting((v) => !v)} />
                ) : null}
                <Button
                  variant="ghost"
                  label={t('m.common.delete')}
                  onPress={() =>
                    Alert.alert(t('m.chapters.delete.title'), t('m.chapters.delete.body'), [
                      { text: t('common.cancel'), style: 'cancel' },
                      {
                        text: t('m.common.delete'),
                        style: 'destructive',
                        onPress: async () => {
                          try {
                            await (await api()).remove(chapter.id);
                            router.back();
                          } catch (e) {
                            setNote(errorMessage(e));
                          }
                        },
                      },
                    ])
                  }
                />
              </>
            ) : null}
          </View>

          {inviting ? (
            <InvitePicker
              exclude={contributors.map((m) => m.user.id)}
              onPick={(u) => void act(async () => (await api()).invite(chapter.id, u.id), t('m.chapters.invited', { name: u.displayName }))()}
            />
          ) : null}

          {chapter.role === 'contributor' ? (
            <Card style={{ gap: space[3] }}>
              <SwitchRow
                label={t('m.chapters.showOnProfile')}
                value={!!chapter.showOnProfile}
                onValueChange={(v) => void act(async () => (await api()).showOnProfile(chapter.id, v))()}
              />
              <Button size="sm" variant="ghost" label={t('m.chapters.leave')} onPress={act(async () => (await api()).removeContributor(chapter.id, me!.id))} />
            </Card>
          ) : null}

          {contributors.length ? (
            <View style={{ gap: space[2] }}>
              <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
                {t('m.chapters.contributors')}
              </Text>
              {contributors.map((m) => (
                <View key={m.user.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
                  <Avatar name={m.user.displayName} url={m.user.avatarUrl} size={36} />
                  <Pressable style={{ flex: 1 }} accessibilityRole="link" onPress={() => router.push(`/u/${m.user.username}`)}>
                    <Text style={[{ color: c.ink, fontWeight: '700' }, userText]}>{m.user.displayName}</Text>
                    {m.status === 'invited' ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('m.chapters.pending')}</Text> : null}
                  </Pressable>
                  {owner ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      label={t('m.chapters.remove')}
                      onPress={act(async () => (await api()).removeContributor(chapter.id, m.user.id))}
                    />
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}

          {stories.length ? (
            <View style={{ gap: space[2] }}>
              <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
                {sealed ? t('m.chapters.yourStoriesInside') : t('m.chapters.storiesHeading')}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[3] }}>
                {stories.map((s, n) => {
                  const src = s.mediaKind === 'image' ? s.mediaUrl : s.posterUrl;
                  return (
                    <View key={s.id} style={{ width: 104, gap: 4 }}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={t('m.chapters.storyBy', { name: s.author.displayName, date: date(s.createdAt, { dateStyle: 'medium' }) })}
                        disabled={sealed}
                        onPress={() => setPlaying(n)}
                        style={{ aspectRatio: 9 / 16, borderRadius: radius.md, overflow: 'hidden', backgroundColor: c.yapi, justifyContent: 'center' }}
                      >
                        {src ? (
                          <Image source={{ uri: mediaUrl(src) }} style={{ flex: 1 }} resizeMode="cover" blurRadius={s.sensitive ? 40 : 0} />
                        ) : (
                          <Text style={[{ color: '#FFFFFF', fontWeight: '700', textAlign: 'center', padding: space[2] }, userText]} numberOfLines={6}>
                            {s.body}
                          </Text>
                        )}
                      </Pressable>
                      <Text style={[{ color: c.inkMuted, fontSize: 12 }, userText]} numberOfLines={2}>
                        {t('m.chapters.storyBy', { name: s.author.displayName, date: date(s.createdAt, { dateStyle: 'medium' }) })}
                      </Text>
                      {owner || s.mine ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          label={t('m.chapters.remove')}
                          onPress={act(async () => (await api()).removeStory(chapter.id, s.id))}
                        />
                      ) : null}
                    </View>
                  );
                })}
              </View>
            </View>
          ) : !sealed ? (
            <EmptyState title={t('m.chapters.empty')} />
          ) : null}

          {!sealed ? (
            <View style={{ gap: space[3] }}>
              <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
                {t('m.chapters.guestbook')}
              </Text>
              {me ? (
                <View style={{ flexDirection: 'row', gap: space[2], alignItems: 'center' }}>
                  <TextInput
                    accessibilityLabel={t('m.chapters.guestbookPlaceholder')}
                    placeholder={t('m.chapters.guestbookPlaceholder')}
                    placeholderTextColor={c.inkMuted}
                    value={line}
                    onChangeText={setLine}
                    maxLength={CHAPTER_GUESTBOOK_MAX}
                    style={[
                      {
                        flex: 1,
                        minHeight: 44,
                        borderWidth: 1,
                        borderRadius: radius.md,
                        paddingHorizontal: space[3],
                        borderColor: c.line,
                        color: c.ink,
                        backgroundColor: c.surface,
                      },
                      userText,
                    ]}
                  />
                  <Button
                    label={t('m.chapters.sign')}
                    disabled={!line.trim()}
                    onPress={async () => {
                      setNote(null);
                      try {
                        const { entry } = await (await api()).sign(chapter.id, line.trim());
                        setLine('');
                        setNote(entry.pending ? t('m.chapters.signedPending') : t('m.chapters.signed'));
                        await load();
                      } catch (e) {
                        setNote(errorMessage(e));
                      }
                    }}
                  />
                </View>
              ) : null}
              {guestbook.length ? (
                guestbook.map((g) => (
                  <View key={g.id} style={{ flexDirection: 'row', gap: space[3], opacity: g.hidden ? 0.55 : 1 }}>
                    <Avatar name={g.author.displayName} url={g.author.avatarUrl} size={32} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={[{ color: c.ink, fontWeight: '700' }, userText]}>
                        {g.author.displayName} <Text style={{ color: c.inkMuted, fontWeight: '400' }}>{timeAgo(g.createdAt)}</Text>
                      </Text>
                      <Text style={[{ color: c.ink, lineHeight: 20 }, userText]}>{g.body}</Text>
                      {g.pending ? <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t('m.chapters.onlyYou')}</Text> : null}
                      {g.hidden ? <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t('m.chapters.hidden')}</Text> : null}
                    </View>
                    {owner ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        label={g.hidden ? t('m.chapters.show') : t('m.chapters.hide')}
                        onPress={act(async () => (await api()).hideLine(chapter.id, g.id, !g.hidden))}
                      />
                    ) : g.mine ? (
                      <Button size="sm" variant="ghost" label={t('m.common.delete')} onPress={act(async () => (await api()).deleteLine(chapter.id, g.id))} />
                    ) : null}
                  </View>
                ))
              ) : (
                <Text style={{ color: c.inkMuted }}>{t('m.chapters.noLines')}</Text>
              )}
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoid>
      <ChapterPlayer
        detail={playing !== null ? data : null}
        start={playing ?? 0}
        onClose={() => {
          setPlaying(null);
          void load();
        }}
      />
    </>
  );
}

/** People who follow you, to invite. Only people you also follow can be added. */
function InvitePicker({ exclude, onPick }: { exclude: string[]; onPick: (u: PublicUser) => void }) {
  const c = useColors();
  const { t } = useT();
  const [q, setQ] = useState('');
  const [items, setItems] = useState<PublicUser[]>([]);
  useEffect(() => {
    const timer = setTimeout(
      () =>
        void client()
          .then((api) => api.people.suggest(q.trim(), 12, 'followers'))
          .then(
            (r) => setItems(r.items.map((x) => x.user)),
            () => setItems([]),
          ),
      q ? 150 : 0,
    );
    return () => clearTimeout(timer);
  }, [q]);
  return (
    <Card style={{ gap: space[3] }}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800' }}>
        {t('m.chapters.inviteTitle')}
      </Text>
      <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.chapters.inviteHint')}</Text>
      <Field label={t('m.closeFriends.search')} hideLabel placeholder={t('m.closeFriends.search')} value={q} onChangeText={setQ} autoCapitalize="none" />
      {items
        .filter((u) => !exclude.includes(u.id))
        .map((u) => (
          <View key={u.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
            <Avatar name={u.displayName} url={u.avatarUrl} size={36} />
            <View style={{ flex: 1 }}>
              <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
                {u.displayName}
              </Text>
              <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
                @{u.username}
              </Text>
            </View>
            <Button size="sm" label={t('m.chapters.invite')} onPress={() => onPick(u)} />
          </View>
        ))}
    </Card>
  );
}
