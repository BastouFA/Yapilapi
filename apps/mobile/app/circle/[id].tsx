import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, ScrollView, Text, View } from 'react-native';
import type { CircleKind } from '../../../../packages/shared/src/constants';
import type { Circle, PublicUser } from '../../../../packages/shared/src/types';
import { client, errorMessage } from '../../lib/api';
import { CIRCLE_NAME_MAX, KindPicker } from '../../lib/circles';
import { useT } from '../../lib/i18n';
import { space } from '../../lib/theme';
import { Avatar, Button, Card, EmptyState, Field, KeyboardAvoid, Loading, Notice, Title, useColors, userText } from '../../lib/ui';

/**
 * One circle: rename it, change its kind, add and remove people (suggestions come from your
 * friends, people you follow and recent chats), or delete it. Nobody is told.
 */
export default function CircleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const { t, tp } = useT();
  const navigation = useNavigation();
  const [circle, setCircle] = useState<Circle | null | undefined>(undefined);
  const [members, setMembers] = useState<PublicUser[]>([]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CircleKind | null>(null);
  const [q, setQ] = useState('');
  const [suggestions, setSuggestions] = useState<PublicUser[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const req = useRef(0);

  useEffect(() => {
    void (async () => {
      try {
        const api = await client();
        const [r, m] = await Promise.all([api.circles.get(id), api.circles.members(id)]);
        setCircle(r.circle);
        setName(r.circle.name);
        setKind(r.circle.kind);
        setMembers(m.items);
      } catch (e) {
        setCircle(null);
        setError(errorMessage(e));
      }
    })();
  }, [id]);

  useLayoutEffect(() => {
    navigation.setOptions({ title: circle?.name ?? t('m.circles.title') });
  }, [navigation, circle?.name, t]);

  useEffect(() => {
    const n = ++req.current;
    const timer = setTimeout(
      () =>
        void client()
          .then((api) => api.people.suggest(q.trim(), 12))
          .then(
            (r) => n === req.current && setSuggestions(r.items.map((x) => x.user)),
            () => {},
          ),
      q ? 150 : 0,
    );
    return () => clearTimeout(timer);
  }, [q]);

  if (circle === undefined) return <Loading />;
  if (circle === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4], gap: space[3] }}>
        <EmptyState title={t('m.post.unavailable.title')} />
        {error ? <Notice tone="danger">{error}</Notice> : null}
      </View>
    );

  async function run(key: string, work: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    run('save', async () => {
      const r = await (await client()).circles.update(id, { name: name.trim(), kind: kind ?? 'custom' });
      setCircle(r.circle);
    });

  const add = (u: PublicUser) =>
    run(u.id, async () => {
      const r = await (await client()).circles.addMembers(id, [u.id]);
      setMembers((cur) => [u, ...cur.filter((x) => x.id !== u.id)]);
      setCircle(r.circle);
    });

  const remove = (u: PublicUser) =>
    run(u.id, async () => {
      const r = await (await client()).circles.removeMember(id, u.id);
      setMembers((cur) => cur.filter((x) => x.id !== u.id));
      setCircle(r.circle);
    });

  const confirmDelete = () =>
    Alert.alert(t('m.circles.deleteTitle', { name: circle.name }), t('m.circles.deleteBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('m.common.delete'),
        style: 'destructive',
        onPress: () =>
          void run('delete', async () => {
            await (await client()).circles.remove(id);
            router.back();
          }),
      },
    ]);

  const changed = name.trim() !== circle.name || (kind ?? 'custom') !== circle.kind;
  const inCircle = new Set(members.map((m) => m.id));
  const addable = suggestions.filter((u) => !inCircle.has(u.id));

  return (
    <KeyboardAvoid>
      <ScrollView
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
        keyboardShouldPersistTaps="handled"
      >
        <Title sub={t('m.circles.hint')}>{circle.name}</Title>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Card style={{ gap: space[3] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>
            {t('m.circles.details')}
          </Text>
          <Field label={t('m.circles.name')} value={name} onChangeText={setName} maxLength={CIRCLE_NAME_MAX} returnKeyType="done" />
          <KindPicker value={kind} onChange={setKind} />
          <Button
            label={busy === 'save' ? t('m.common.saving') : t('common.save')}
            size="sm"
            disabled={!!busy || !changed || !name.trim()}
            onPress={() => save()}
            style={{ alignSelf: 'flex-start' }}
          />
        </Card>
        <Card style={{ gap: space[3] }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>
            {t('m.circles.inCircle')} · {tp('m.circles.members', members.length)}
          </Text>
          {members.length ? (
            members.map((u) => (
              <Person key={u.id} user={u} action={t('m.common.remove')} variant="ghost" disabled={busy === u.id} onPress={() => void remove(u)} />
            ))
          ) : (
            <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.circles.noMembers')}</Text>
          )}
        </Card>
        <Card style={{ gap: space[3] }}>
          <Field
            label={t('m.circles.addHeading')}
            placeholder={t('m.closeFriends.search')}
            value={q}
            onChangeText={setQ}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {addable.length ? (
            addable.map((u) => (
              <Person key={u.id} user={u} action={t('m.closeFriends.add')} variant="secondary" disabled={busy === u.id} onPress={() => void add(u)} />
            ))
          ) : (
            <Text style={{ color: c.inkMuted }} accessibilityLiveRegion="polite">
              {t('m.circles.noSuggestions')}
            </Text>
          )}
        </Card>
        <Button label={t('m.circles.delete')} variant="danger" icon="trash-outline" disabled={!!busy} onPress={confirmDelete} />
      </ScrollView>
    </KeyboardAvoid>
  );
}

function Person({
  user,
  action,
  variant,
  disabled,
  onPress,
}: {
  user: PublicUser;
  action: string;
  variant: 'ghost' | 'secondary';
  disabled: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
      <Avatar name={user.displayName} url={user.avatarUrl} size={36} />
      <View style={{ flex: 1 }}>
        <Text style={[{ color: c.ink, fontWeight: '600' }, userText]} numberOfLines={1}>
          {user.displayName}
        </Text>
        <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
          @{user.username}
        </Text>
      </View>
      <Button label={action} size="sm" variant={variant} disabled={disabled} onPress={onPress} />
    </View>
  );
}
