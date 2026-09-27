import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { forgotPassword } from '../lib/api';
import { AuthPage, authProblem } from '../lib/auth-ui';
import { useT } from '../lib/i18n';
import { Button, Field, Notice, Title } from '../lib/ui';

/**
 * Forgot password: we email a link to choose a new one (it opens on the web and works for an
 * hour). The answer is the same whether or not the address has an account, so nobody can use
 * this screen to find out who is on YAPILAPI.
 */
export default function ForgotPassword() {
  const { t } = useT();
  const params = useLocalSearchParams<{ email?: string }>();
  const [email, setEmail] = useState(params.email ?? '');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = /^\S+@\S+\.\S+$/.test(email.trim());

  async function send() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await forgotPassword(email.trim());
      setSent(true);
      AccessibilityInfo.announceForAccessibility(t('m.auth.reset.sent', { email: email.trim() }));
    } catch (e) {
      setError(authProblem(e, t).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthPage>
      <Title sub={t('m.auth.reset.body')}>{t('m.auth.reset.title')}</Title>
      {sent ? <Notice title={t('m.auth.reset.checkInbox')}>{t('m.auth.reset.sent', { email: email.trim() })}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Field
        label={t('auth.email')}
        value={email}
        onChangeText={(v) => {
          setEmail(v);
          setSent(false);
        }}
        autoFocus={!params.email}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="emailAddress"
        keyboardType="email-address"
        returnKeyType="send"
        onSubmitEditing={() => void send()}
      />
      <Button
        label={busy ? t('m.auth.reset.sending') : sent ? t('m.auth.reset.again') : t('m.auth.reset.submit')}
        variant={sent ? 'secondary' : 'primary'}
        disabled={busy || !valid}
        onPress={() => void send()}
      />
      <Button
        label={t('m.auth.reset.back')}
        variant={sent ? 'primary' : 'ghost'}
        onPress={() => (router.canGoBack() ? router.back() : router.replace({ pathname: '/login', params: { email: email.trim() } }))}
      />
    </AuthPage>
  );
}
