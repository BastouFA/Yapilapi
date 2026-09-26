import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { AgentKind, AgentResult } from '../../../packages/api-client/src/index';
import { client, errorMessage } from '../lib/api';
import { space } from '../lib/theme';
import { Button, Card, Field, Notice, Row, Screen, Segmented, useColors } from '../lib/ui';

const KINDS: { id: AgentKind; label: string; placeholder: string }[] = [
  { id: 'discover', label: 'Discover', placeholder: 'What are you in the mood for?' },
  { id: 'travel', label: 'Trips', placeholder: 'Where are you going, and when?' },
  { id: 'shopping', label: 'Shopping', placeholder: 'What do you need?' },
  { id: 'business', label: 'Business', placeholder: 'Ask about your bookings, reviews or sales' },
];
const TYPE_LABEL: Record<string, string> = {
  event: 'Event',
  place: 'Place',
  community: 'Community',
  person: 'Person',
  product: 'Product',
  business: 'Business',
};

/** Screens that exist in the app; other results show their details without opening. */
const route = (href: string) => (/^\/(c|p)\//.test(href) ? href : null);

/**
 * The same assistants as the web app. Results are things that exist on
 * YAPILAPI; RSVP, follow and join happen only when you tap them. Bookings and
 * purchases need the item's page on the web.
 */
export default function Assistant() {
  const c = useColors();
  const [kind, setKind] = useState<AgentKind>('discover');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AgentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const k = KINDS.find((x) => x.id === kind)!;

  async function ask() {
    if (!prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setRes(await (await client()).agents.run(kind, prompt.trim()));
    } catch (e) {
      setRes(null);
      setError(kind === 'business' && /not found/i.test(errorMessage(e)) ? 'The business assistant works for business owners.' : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function act(a: AgentResult['actions'][number]) {
    const api = await client();
    try {
      if (a.kind === 'rsvp') await api.events.rsvp(a.target.id, 'going');
      else if (a.kind === 'follow') await api.users.follow(a.target.id);
      else if (a.kind === 'join') await api.communities.join(a.target.href.replace('/c/', ''));
      setDone((d) => ({ ...d, [a.target.id]: true }));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: space[3], paddingBottom: space[8] }} keyboardShouldPersistTaps="handled">
        <Segmented
          label="Assistant"
          options={KINDS}
          value={kind}
          onChange={(v) => {
            setKind(v);
            setRes(null);
            setError(null);
          }}
        />
        <Field
          label="Ask"
          hideLabel
          placeholder={k.placeholder}
          value={prompt}
          onChangeText={setPrompt}
          onSubmitEditing={ask}
          returnKeyType="send"
          maxLength={1000}
        />
        <Button label={busy ? 'Thinking…' : 'Ask'} onPress={ask} disabled={busy || !prompt.trim()} />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {res ? (
          <Card style={{ gap: space[3] }}>
            {res.text ? <Text style={{ color: c.ink, fontSize: 15, lineHeight: 22 }}>{res.text}</Text> : null}
            {res.recommendations.map((r) => (
              <Row
                key={`${r.type}:${r.id}`}
                title={r.title}
                subtitle={`${TYPE_LABEL[r.type]}${r.startsAt ? ` · ${new Date(r.startsAt).toLocaleString()}` : ''}${r.subtitle ? ` · ${r.subtitle}` : ''}\n${r.reason}`}
                onPress={route(r.href) ? () => router.push(route(r.href) as never) : undefined}
              />
            ))}
            {res.actions.map((a) =>
              a.kind === 'book' || a.kind === 'buy' ? (
                <Text key={a.target.id} style={{ color: c.inkMuted, fontSize: 13 }}>
                  {a.label}: finish this on the item's page on the web.
                </Text>
              ) : (
                <Button
                  key={a.target.id}
                  label={done[a.target.id] ? 'Done' : a.label}
                  variant={done[a.target.id] ? 'secondary' : 'primary'}
                  disabled={done[a.target.id]}
                  onPress={() => act(a)}
                />
              ),
            )}
            <Text style={{ color: c.inkMuted, fontSize: 12 }}>{res.notice ?? `Answered by ${res.model}. It only used what you can see on YAPILAPI.`}</Text>
          </Card>
        ) : null}
        <View>
          <Text style={{ color: c.inkMuted, fontSize: 12, lineHeight: 18 }}>
            The assistant searches YAPILAPI as you, so it only finds what you could find yourself. Your question is sent to the AI provider to answer it;
            YAPILAPI keeps a record that you asked, not what you asked.
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}
