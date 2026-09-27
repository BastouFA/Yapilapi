import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View, type TextInput } from 'react-native';
import { client, register, usernameAvailable } from '../lib/api';
import { AuthPage, authProblem, enterApp, isoDay, PasswordField, USERNAME_RE, usernameFrom } from '../lib/auth-ui';
import { DateField } from '../lib/date-time';
import { useT } from '../lib/i18n';
import { useSession } from '../lib/session';
import { space } from '../lib/theme';
import { Button, Field, Icon, Notice, Title, useColors } from '../lib/ui';

const MIN_PASSWORD = 10;

/**
 * Create an account: name, username (checked as you type, suggested from the name), email,
 * password, and optionally a date of birth and a friend's invite code (filled in from an invite
 * link). Problems show next to the field they are about. Then onboarding.
 */
export default function Signup() {
  const c = useColors();
  const { t, locale } = useT();
  const { refresh } = useSession();
  const params = useLocalSearchParams<{ invite?: string }>();
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [birth, setBirth] = useState<Date | null>(null);
  const [invite, setInvite] = useState(params.invite ?? '');
  const [showInvite, setShowInvite] = useState(!!params.invite);
  const [invitedBy, setInvitedBy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const usernameRef = useRef<TextInput>(null);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);

  // From an invite link: say who invited you.
  useEffect(() => {
    if (!params.invite) return;
    void client()
      .then((api) => api.invites.preview(params.invite!))
      .then(
        (r) => setInvitedBy(r.inviter.displayName),
        () => {},
      );
  }, [params.invite]);

  // Until the person types their own, the username follows the name.
  useEffect(() => {
    if (!usernameTouched) setUsername(usernameFrom(name));
  }, [name, usernameTouched]);

  // Is it free? Checked a moment after typing stops.
  useEffect(() => {
    setAvailable(null);
    if (!USERNAME_RE.test(username)) return;
    let live = true;
    const timer = setTimeout(() => void usernameAvailable(username).then((ok) => live && setAvailable(ok)), 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [username]);

  const today = new Date();
  const earliest = new Date(1900, 0, 1);
  const openAt = new Date(today.getFullYear() - 18, today.getMonth(), today.getDate());

  function check(): Record<string, string> {
    const f: Record<string, string> = {};
    if (!name.trim()) f.displayName = t('m.auth.nameNeeded');
    if (!USERNAME_RE.test(username)) f.username = t('m.auth.usernameRule');
    else if (available === false) f.username = t('m.auth.usernameTaken');
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) f.email = t('m.auth.emailInvalid');
    if (password.length < MIN_PASSWORD) f.password = t('auth.password.hint');
    return f;
  }

  async function submit() {
    if (busy) return;
    const f = check();
    setFields(f);
    if (Object.keys(f).length) {
      setError(t('m.auth.fixFields'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const user = await register({
        displayName: name.trim(),
        username: username.trim(),
        email: email.trim(),
        password,
        birthDate: birth ? isoDay(birth) : undefined,
        locale,
        inviteCode: invite.trim() || undefined,
      });
      await enterApp(user, refresh);
    } catch (e) {
      const p = authProblem(e, t);
      setError(p.message);
      setFields(p.fields);
      if (p.fields.inviteCode) setShowInvite(true);
      setBusy(false);
    }
  }

  return (
    <AuthPage>
      <Title sub={t('m.auth.signup.body')}>{t('auth.signup.title')}</Title>
      {invitedBy ? (
        <Notice>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
            <Icon name="gift-outline" size={18} color={c.yapi} />
            <Text style={{ color: c.ink, flex: 1 }}>{t('auth.invitedBy', { name: invitedBy })}</Text>
          </View>
        </Notice>
      ) : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Field
        label={t('auth.displayName')}
        value={name}
        onChangeText={setName}
        autoComplete="name"
        textContentType="name"
        maxLength={60}
        returnKeyType="next"
        onSubmitEditing={() => usernameRef.current?.focus()}
        error={fields.displayName}
      />
      <Field
        ref={usernameRef}
        label={t('auth.username')}
        value={username}
        onChangeText={(v) => {
          setUsernameTouched(true);
          setUsername(v.replace(/\s+/g, '').toLowerCase());
        }}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="username-new"
        textContentType="username"
        maxLength={30}
        returnKeyType="next"
        onSubmitEditing={() => emailRef.current?.focus()}
        hint={available && username ? t('m.auth.usernameFree', { username }) : t('m.auth.usernameRule')}
        error={fields.username ?? (available === false ? t('m.auth.usernameTaken') : null)}
      />
      <Field
        ref={emailRef}
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
        autoComplete="new-password"
        textContentType="newPassword"
        passwordRules="minlength: 10;"
        hint={t('auth.password.hint')}
        error={fields.password}
      />
      <DateField
        mode="date"
        label={t('m.auth.birthDate')}
        sheetTitle={t('m.auth.birthDate')}
        value={birth}
        onChange={setBirth}
        min={earliest}
        max={today}
        openAt={openAt}
        placeholder={t('m.auth.birthDate.optional')}
        note={fields.birthDate ?? t('m.auth.birthDate.hint')}
      />
      {showInvite ? (
        <Field
          label={t('auth.inviteCode')}
          value={invite}
          onChangeText={setInvite}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={32}
          error={fields.inviteCode}
        />
      ) : (
        <Pressable accessibilityRole="button" onPress={() => setShowInvite(true)} style={{ alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center' }}>
          <Text style={{ color: c.yapi, fontWeight: '700' }}>{t('m.auth.haveInvite')}</Text>
        </Pressable>
      )}
      <Button label={busy ? t('m.auth.creating') : t('auth.signup.submit')} disabled={busy} onPress={() => void submit()} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: space[1] }}>
        <Text style={{ color: c.inkMuted }}>{t('auth.haveAccount')}</Text>
        <Pressable
          accessibilityRole="link"
          onPress={() => router.replace('/login')}
          style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: space[1] }}
        >
          <Text style={{ color: c.yapi, fontWeight: '700' }}>{t('auth.login.submit')}</Text>
        </Pressable>
      </View>
    </AuthPage>
  );
}
