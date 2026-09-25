import React, { useState } from 'react';
import { useTheme } from '../../theme';
import { useT } from '../../i18n';
import { useApi } from '../../auth/AuthProvider';
import { errorMessage } from '../../lib/errors';
import { isEmail } from '../../lib/validation';
import { AppText, Button, Screen, TextField } from '../../ui';

export default function Forgot() {
  const th = useTheme();
  const t = useT();
  const api = useApi();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!isEmail(email)) {
      setError(t('signup.account.emailInvalid'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.auth.forgotPassword(email.trim());
      setSent(true);
    } catch (e) {
      setError(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen scroll>
      <AppText variant="body" tone="muted" style={{ marginBottom: th.space[4] }}>
        {t('forgot.body')}
      </AppText>
      <TextField
        label={t('login.email')}
        value={email}
        onChangeText={setEmail}
        error={error}
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        editable={!sent}
        required
      />
      {sent ? (
        <AppText
          variant="body"
          tone="success"
          accessibilityLiveRegion="polite"
          style={{ marginBottom: th.space[3] }}
        >
          {t('forgot.sent')}
        </AppText>
      ) : null}
      <Button
        label={t('forgot.submit')}
        block
        loading={busy}
        disabled={sent}
        onPress={() => void submit()}
      />
    </Screen>
  );
}
