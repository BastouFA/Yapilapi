import { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { PublicUser } from '../../../packages/shared/src/types';
import { client, errorMessage } from '../lib/api';
import { useT } from '../lib/i18n';
import { useSession } from '../lib/session';
import { space } from '../lib/theme';
import { Avatar, Button, Card, Field, Loading, Notice, Title, useColors, userText } from '../lib/ui';

type Entry = { user: PublicUser; followsYou: boolean };

/**
 * Close friends: people who follow you and see the stories you share with close friends only.
 * Nobody is told when they're added or removed. Search uses the people suggestions, narrowed to
 * your followers.
 */
export default function CloseFriends() {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const [list, setList] = useState<Entry[] | null>(null);
  const [q, setQ] = useState('');
  const [suggestions, setSuggestions] = useState<PublicUser[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const req = useRef(0);

  useEffect(() => {
    client()
      .then((api) => api.closeFriends.list())
      .then(
        (r) => setList(r.items),
        (e) => {
          setList([]);
          setError(errorMessage(e));
        },
      );
  }, []);

  useEffect(() => {
    const n = ++req.current;
    const timer = setTimeout(
      () =>
        void client()
          .then((api) => api.people.suggest(q.trim(), 12, 'followers'))
          .then(
            (r) => n === req.current && setSuggestions(r.items.map((x) => x.user)),
            () => {},
          ),
      q ? 150 : 0,
    );
    return () => clearTimeout(timer);
  }, [q]);

  if (me === undefined || list === null) return <Loading />;
  if (!me)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice>{t('m.common.signedOut')}</Notice>
      </View>
    );

  async function add(u: PublicUser) {
    setBusy(u.id);
    setError(null);
    try {
      await (await client()).closeFriends.add(u.id);
      setList((cur) => [{ user: u, followsYou: true }, ...(cur ?? []).filter((x) => x.user.id !== u.id)]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(u: PublicUser) {
    setBusy(u.id);
    setError(null);
    try {
      await (await client()).closeFriends.remove(u.id);
      setList((cur) => (cur ?? []).filter((x) => x.user.id !== u.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const onList = new Set(list.map((x) => x.user.id));
  const addable = suggestions.filter((u) => !onList.has(u.id));

  return (
    <ScrollView
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
      keyboardShouldPersistTaps="handled"
    >
      <Title sub={t('m.closeFriends.hint')}>{t('m.closeFriends.title')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Card style={{ gap: space[3] }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>
          {t('m.closeFriends.onList')} ({list.length})
        </Text>
        {list.length ? (
          list.map((x) => (
            <Person
              key={x.user.id}
              user={x.user}
              note={x.followsYou ? undefined : t('m.closeFriends.notFollowing')}
              dot={c.closeFriends}
              action={t('m.closeFriends.remove')}
              variant="ghost"
              disabled={busy === x.user.id}
              onPress={() => void remove(x.user)}
            />
          ))
        ) : (
          <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('m.closeFriends.empty')}</Text>
        )}
      </Card>
      <Card style={{ gap: space[3] }}>
        <Field
          label={t('m.closeFriends.addHeading')}
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
            {t('m.closeFriends.none')}
          </Text>
        )}
      </Card>
    </ScrollView>
  );
}

function Person({
  user,
  note,
  dot,
  action,
  variant,
  disabled,
  onPress,
}: {
  user: PublicUser;
  note?: string;
  dot?: string;
  action: string;
  variant: 'ghost' | 'secondary';
  disabled: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
      {dot ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: dot }} /> : null}
      <Avatar name={user.displayName} url={user.avatarUrl} size={36} />
      <View style={{ flex: 1 }}>
        <Text style={[{ color: c.ink, fontWeight: '600' }, userText]} numberOfLines={1}>
          {user.displayName}
        </Text>
        <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={2}>
          @{user.username}
          {note ? ` · ${note}` : ''}
        </Text>
      </View>
      <Button label={action} size="sm" variant={variant} disabled={disabled} onPress={onPress} />
    </View>
  );
}
