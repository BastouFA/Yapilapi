import { router } from 'expo-router';
import { useState } from 'react';
import { Text } from 'react-native';
import { client } from '../lib/api';
import { Button, Field, Screen, useColors } from '../lib/ui';

const VISIBILITY = [
  { id: 'public', label: 'Everyone' },
  { id: 'followers', label: 'Followers' },
  { id: 'friends', label: 'Friends' },
  { id: 'private', label: 'Only me' },
] as const;

/** Create: a text post with a visibility choice. */
export default function Create() {
  const c = useColors();
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<(typeof VISIBILITY)[number]['id']>('public');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Screen>
      <Field
        label="What's happening?"
        value={body}
        onChangeText={setBody}
        multiline
        maxLength={5000}
        style={{ minHeight: 140, textAlignVertical: 'top', paddingTop: 12 }}
      />
      <Text style={{ color: c.ink, fontWeight: '600' }}>Who can see this</Text>
      {VISIBILITY.map((v) => (
        <Button key={v.id} label={v.label} variant={v.id === visibility ? 'primary' : 'secondary'} onPress={() => setVisibility(v.id)} />
      ))}
      {error ? <Text style={{ color: c.danger }}>{error}</Text> : null}
      <Button
        label={busy ? 'Publishing…' : 'Publish'}
        disabled={!body.trim() || busy}
        onPress={async () => {
          setBusy(true);
          setError(null);
          try {
            await (await client()).posts.create({ body, visibility });
            setBody('');
            router.navigate('/');
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      />
    </Screen>
  );
}
