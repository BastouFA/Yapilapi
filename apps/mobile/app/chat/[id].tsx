import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Text, View } from 'react-native';
import type { Message } from '../../../../packages/shared/src/types';
import { client } from '../../lib/api';
import { radius, space } from '../../lib/theme';
import { Button, Field, useColors } from '../../lib/ui';

/** A conversation. Polls every few seconds; the web app uses the realtime socket. */
export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const [me, setMe] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [body, setBody] = useState('');

  useEffect(() => {
    let stop = false;
    const load = async () => {
      const api = await client();
      if (!me) setMe((await api.auth.me()).user.id);
      const page = await api.conversations.messages(id);
      if (!stop) setMessages(page.items);
      await api.conversations.read(id);
    };
    void load();
    const t = setInterval(load, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [id, me]);

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.ground }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <FlatList
        data={messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: space[4], gap: space[2] }}
        renderItem={({ item }) => {
          const mine = item.sender.id === me;
          return (
            <View
              style={{
                alignSelf: mine ? 'flex-end' : 'flex-start',
                maxWidth: '80%',
                padding: space[3],
                borderRadius: radius.md,
                backgroundColor: mine ? c.yapi : c.surface,
              }}
            >
              {!mine ? <Text style={{ color: c.yapi, fontSize: 12, fontWeight: '600' }}>{item.sender.displayName}</Text> : null}
              <Text style={{ color: mine ? c.onYapi : c.ink, fontSize: 15 }}>{item.body}</Text>
            </View>
          );
        }}
      />
      <View style={{ padding: space[3], gap: space[2] }}>
        <Field label="Message" value={body} onChangeText={setBody} maxLength={4000} />
        <Button
          label="Send"
          disabled={!body.trim()}
          onPress={async () => {
            const text = body.trim();
            setBody('');
            const { message } = await (await client()).conversations.send(id, text, `${Date.now()}`);
            setMessages((cur) => [...cur, message]);
          }}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
