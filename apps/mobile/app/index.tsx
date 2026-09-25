import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, useColorScheme, View } from 'react-native';
import type { Post } from '../../../packages/shared/src/types';
import { client, signIn } from '../lib/api';
import { palette, radius, space } from '../lib/theme';

/** Home: sign in if needed, then the For You feed with cursor pagination. */
export default function Home() {
  const c = palette(useColorScheme() === 'dark' ? 'dark' : 'light');
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (next?: string) => {
    const api = await client();
    const page = await api.feed('for_you', next);
    setPosts((cur) => (next ? [...cur, ...page.items] : page.items));
    setCursor(page.nextCursor);
  }, []);

  useEffect(() => {
    client()
      .then((api) => api.auth.me())
      .then(() => (setAuthed(true), load()))
      .catch(() => setAuthed(false));
  }, [load]);

  if (authed === null) return <ActivityIndicator style={{ flex: 1, backgroundColor: c.ground }} color={c.yapi} />;
  if (!authed) return <SignIn onDone={() => (setAuthed(true), load())} />;

  return (
    <FlatList
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[3] }}
      data={posts}
      keyExtractor={(p) => p.id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => (setRefreshing(true), await load(), setRefreshing(false))} />}
      onEndReached={() => cursor && load(cursor)}
      ListFooterComponent={<Text style={{ color: c.inkMuted, textAlign: 'center', padding: space[4] }}>{cursor ? 'Loading…' : "You're all caught up."}</Text>}
      renderItem={({ item }) => (
        <View style={[s.card, { backgroundColor: c.surface, borderColor: c.line }]} accessible accessibilityLabel={`${item.author.displayName}: ${item.body}`}>
          <Text style={[s.name, { color: c.ink }]}>{item.author.displayName}</Text>
          {item.reason ? <Text style={{ color: c.inkMuted, fontSize: 12 }}>{item.reason}</Text> : null}
          <Text style={{ color: c.ink, fontSize: 15, lineHeight: 23, marginTop: space[2] }}>{item.body}</Text>
          <Text style={{ color: c.inkMuted, fontSize: 12, marginTop: space[2] }}>
            {item.counts.likes} likes · {item.counts.comments} comments
          </Text>
        </View>
      )}
    />
  );
}

function SignIn({ onDone }: { onDone: () => void }) {
  const c = palette(useColorScheme() === 'dark' ? 'dark' : 'light');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <View style={{ flex: 1, padding: space[6], gap: space[3], justifyContent: 'center', backgroundColor: c.ground }}>
      <Text style={{ color: c.ink, fontSize: 28, fontWeight: '700' }}>Log in</Text>
      {error ? <Text style={{ color: c.danger }}>{error}</Text> : null}
      <TextInput
        accessibilityLabel="Email address"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
        style={[s.input, { borderColor: c.line, color: c.ink }]}
      />
      <TextInput
        accessibilityLabel="Password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
        style={[s.input, { borderColor: c.line, color: c.ink }]}
      />
      <Pressable
        accessibilityRole="button"
        style={[s.button, { backgroundColor: c.yapi }]}
        onPress={async () => {
          try {
            await signIn(email, password);
            onDone();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <Text style={{ color: c.onYapi, fontWeight: '600' }}>Log in</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  card: { padding: space[4], borderWidth: 1, borderRadius: radius.md },
  name: { fontSize: 15, fontWeight: '600' },
  input: { height: 44, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: space[3] },
  button: { height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
});
