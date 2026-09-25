import React, { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { ApiError } from '@yapilapi/api-client';
import { useTheme } from '../../theme';
import { useT } from '../../i18n';
import { useAuth } from '../../auth/AuthProvider';
import { setPendingMfa } from '../../auth/pending-mfa';
import { errorMessage } from '../../lib/errors';
import { isEmail } from '../../lib/validation';
import { AppText, Button, Screen, TextField } from '../../ui';

export default function Login() {
  const th = useTheme();
  const t = useT();
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const next: typeof errors = {};
    if (!isEmail(email)) next.email = t('login.emailRequired');
    if (!password) next.password = t('login.passwordRequired');
    setErrors(next);
    setFormError(null);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      const out = await login(email, password);
      if (out.kind === 'mfa') {
        setPendingMfa(out.challengeToken);
        router.push('/mfa');
      }
    } catch (e) {
      setFormError(
        e instanceof ApiError && e.status === 401 ? t('login.badCredentials') : errorMessage(e, t),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll>
      <TextField
        label={t('login.email')}
        value={email}
        onChangeText={setEmail}
        error={errors.email}
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        textContentType="emailAddress"
        autoCorrect={false}
        returnKeyType="next"
        required
      />
      <TextField
        label={t('login.password')}
        value={password}
        onChangeText={setPassword}
        error={errors.password}
        password
        autoCapitalize="none"
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        required
      />
      {formError ? (
        <AppText
          variant="body"
          tone="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={{ marginBottom: th.space[3] }}
        >
          {formError}
        </AppText>
      ) : null}
      <Button label={t('login.submit')} block loading={busy} onPress={() => void submit()} />
      <View style={{ marginTop: th.space[4], gap: th.space[2], alignItems: 'center' }}>
        <Button label={t('login.forgot')} variant="ghost" onPress={() => router.push('/forgot')} />
        <Button
          label={t('login.noAccount')}
          variant="ghost"
          onPress={() => router.replace('/signup')}
        />
      </View>
    </Screen>
  );
}
