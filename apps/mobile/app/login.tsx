import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { Pressable, Text, View, type TextInput } from 'react-native';
import { ApiError } from '../../../packages/api-client/src/index';
import { appealSuspension, errorMessage, MAX_ACCOUNTS, signIn, verifyTwoStep } from '../lib/api';
import { AuthPage, authProblem, enterApp, PasswordField } from '../lib/auth-ui';
import { useT } from '../lib/i18n';
import { useSession } from '../lib/session';
import { space } from '../lib/theme';
import { Button, Field, Notice, Title, useColors } from '../lib/ui';

/**
 * Log in with email and password. Accounts with two-step verification then enter a code from
 * their authenticator app (or a recovery code). Forgot password and Create account are one tap away.
 */
export default function Login() {
  const c = useColors();
  const { t } = useT();
  const { enter, me, accounts } = useSession();
  const params = useLocalSearchParams<{ email?: string; add?: string }>();
  // From the account menu: log in to another account, kept alongside the ones already here.
  const adding = params.add === '1' && !!me;
  const full = adding && accounts.length >= MAX_ACCOUNTS;
  const [email, setEmail] = useState(params.email ?? '');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  // A suspended account signed in with the right password: it can appeal from here (it can't reach Settings).
  const [appealToken, setAppealToken] = useState<string | null>(null);
  const passwordRef = useRef<TextInput>(null);

  const ready = challenge ? code.trim().length >= 6 : /\S+@\S+\.\S+/.test(email.trim()) && password.length > 0;

  async function submit() {
    if (!ready || busy || full) return;
    setBusy(true);
    setError(null);
    setFields({});
    setAppealToken(null);
    try {
      if (challenge) {
        const user = await verifyTwoStep(challenge, code);
        await enterApp(user, enter);
        return;
      }
      const r = await signIn(email.trim(), password);
      if ('challengeToken' in r) {
        setChallenge(r.challengeToken);
        setBusy(false);
        return;
      }
      await enterApp(r.user, enter);
    } catch (e) {
      const p = authProblem(e, t, !!challenge);
      // An expired two-step sign-in (or one with too many wrong codes) starts again from the password.
      if (challenge && e instanceof ApiError && (e.status === 401 || e.code === 'too_many_attempts')) {
        setChallenge(null);
        setCode('');
      }
      setError(p.message);
      setFields(p.fields);
      const appeal = e instanceof ApiError && e.code === 'account_suspended' ? (e.details?.appeal as { token?: string } | undefined) : undefined;
      if (appeal?.token) setAppealToken(appeal.token);
      setBusy(false);
    }
  }

  if (challenge)
    return (
      <AuthPage>
        <Title sub={t('m.auth.twoStep.body')}>{t('m.auth.twoStep.title')}</Title>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Field
          label={t('m.auth.twoStep.code')}
          value={code}
          onChangeText={setCode}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          keyboardType="default"
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
          error={fields.code}
        />
        <Button label={busy ? t('m.auth.loggingIn') : t('m.auth.twoStep.submit')} disabled={busy || !ready} onPress={() => submit()} />
        <Button
          label={t('m.common.back')}
          variant="ghost"
          onPress={() => {
            setChallenge(null);
            setCode('');
            setError(null);
          }}
        />
      </AuthPage>
    );

  return (
    <AuthPage>
      <Title sub={adding ? t('acct.addHint') : t('m.auth.login.body')}>{adding ? t('acct.addTitle') : t('auth.login.title')}</Title>
      {full ? <Notice tone="warn">{t('acct.max', { count: MAX_ACCOUNTS })}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {appealToken ? <SuspensionAppeal token={appealToken} /> : null}
      <Field
        label={t('auth.email')}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="emailAddress"
        keyboardType="email-address"
        returnKeyType="next"
        onSubmitEditing={() => passwordRef.current?.focus()}
        error={fields.email}
      />
      <PasswordField
        t={t}
        ref={passwordRef}
        label={t('auth.password')}
        value={password}
        onChangeText={setPassword}
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
      />
      <Pressable
        accessibilityRole="link"
        onPress={() => router.push({ pathname: '/forgot-password', params: email.trim() ? { email: email.trim() } : {} })}
        style={{ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' }}
      >
        <Text style={{ color: c.yapi, fontWeight: '700' }}>{t('auth.forgot')}</Text>
      </Pressable>
      <Button label={busy ? t('m.auth.loggingIn') : t('auth.login.submit')} disabled={busy || !ready || full} onPress={() => submit()} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: space[1], marginTop: space[2] }}>
        <Text style={{ color: c.inkMuted }}>{t('auth.noAccount')}</Text>
        <Pressable
          accessibilityRole="link"
          onPress={() => router.replace('/signup')}
          style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: space[1] }}
        >
          <Text style={{ color: c.yapi, fontWeight: '700' }}>{t('m.welcome.create')}</Text>
        </Pressable>
      </View>
    </AuthPage>
  );
}

/** Appealing a suspension from the sign-in screen, with the one-time token signing in gave. */
function SuspensionAppeal({ token }: { token: string }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (sent) return <Notice>{t('settings.appeal.sent')}</Notice>;
  if (!open) return <Button label={t('settings.appeal.title')} variant="secondary" onPress={() => setOpen(true)} />;
  return (
    <View style={{ gap: space[2] }}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Field label={t('settings.appeal.why')} value={statement} onChangeText={setStatement} multiline maxLength={2000} autoFocus />
      <Button
        label={t('settings.appeal.send')}
        disabled={busy || !statement.trim()}
        onPress={async () => {
          setBusy(true);
          setError(null);
          try {
            await appealSuspension(token, statement.trim());
            setSent(true);
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      />
    </View>
  );
}
