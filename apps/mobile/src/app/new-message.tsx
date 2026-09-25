import React, { useState } from 'react';
import { useRouter } from 'expo-router';
import { useTheme } from '../theme';
import { useT } from '../i18n';
import { useStartDirect } from '../data/inbox';
import { errorMessage } from '../lib/errors';
import { AppText, Button, Screen, TextField } from '../ui';

export default function NewMessage() {
  const th = useTheme();
  const t = useT();
  const router = useRouter();
  const start = useStartDirect();
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);

  const go = () => {
    const u = username.trim().replace(/^@/, '').toLowerCase();
    if (!u) {
      setError(t('inbox.newBody'));
      return;
    }
    setError(null);
    start.mutate(u, {
      // Unknown user, blocked, or a teen's friends-only rule all come back as a plain "not found / not allowed" from the API.
      onSuccess: (c) => router.replace({ pathname: '/chat/[id]', params: { id: c.id } }),
      onError: (e) => setError(errorMessage(e, t)),
    });
  };
  return (
    <Screen scroll>
      <AppText variant="body" tone="muted" style={{ marginBottom: th.space[4] }}>
        {t('inbox.newBody')}
      </AppText>
      <TextField
        label={t('inbox.username')}
        value={username}
        onChangeText={setUsername}
        error={error}
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={go}
        returnKeyType="go"
      />
      <Button label={t('inbox.start')} block loading={start.isPending} onPress={go} />
    </Screen>
  );
}
