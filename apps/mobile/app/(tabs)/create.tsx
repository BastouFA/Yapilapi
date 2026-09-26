import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, Text } from 'react-native';
import type { MessageKey } from '../../../../packages/shared/src/i18n';
import { client, errorMessage } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { useSession } from '../../lib/session';
import { space } from '../../lib/theme';
import { Button, Card, Field, Notice, Screen, Segmented, useColors, useTabBarSpace } from '../../lib/ui';

const VISIBILITY = [
  { id: 'public', label: 'visibility.public' },
  { id: 'followers', label: 'visibility.followers' },
  { id: 'friends', label: 'visibility.friends' },
  { id: 'private', label: 'visibility.private' },
] as const satisfies readonly { id: string; label: MessageKey }[];

/** Create: a text post with a visibility choice, or a Real. */
export default function Create() {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const bottom = useTabBarSpace();
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<(typeof VISIBILITY)[number]['id']>('public');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!me)
    return (
      <Screen>
        <Notice>{t('m.create.signedOut')}</Notice>
      </Screen>
    );

  return (
    <ScrollView
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[3], paddingBottom: bottom }}
      keyboardShouldPersistTaps="handled"
    >
      <Card style={{ gap: space[3] }}>
        <Field
          label={t('create.placeholder')}
          value={body}
          onChangeText={setBody}
          multiline
          maxLength={5000}
          style={{ minHeight: 140, textAlignVertical: 'top', paddingTop: 12 }}
        />
        <Text style={{ color: c.ink, fontWeight: '600' }}>{t('create.visibility')}</Text>
        <Segmented
          label={t('create.visibility')}
          options={VISIBILITY.map((v) => ({ id: v.id, label: t(v.label) }))}
          value={visibility}
          onChange={setVisibility}
        />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {note ? <Notice>{note}</Notice> : null}
        <Button
          label={busy ? t('m.create.publishing') : t('create.publish')}
          disabled={!body.trim() || busy}
          onPress={async () => {
            setBusy(true);
            setError(null);
            setNote(null);
            try {
              const r = await (await client()).posts.create({ body, visibility });
              setBody('');
              if (r.moderation) setNote(r.moderation.message);
              else router.navigate('/');
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        />
      </Card>
      <Button label={t('m.real.capture')} icon="camera-outline" variant="secondary" onPress={() => router.push('/real')} />
    </ScrollView>
  );
}
