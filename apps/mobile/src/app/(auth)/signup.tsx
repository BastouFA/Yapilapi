import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ApiError } from '@yapilapi/api-client';
import { useTheme } from '../../theme';
import { useT } from '../../i18n';
import { useApi, useAuth } from '../../auth/AuthProvider';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { MIN_AGE_YEARS, PASSWORD_MIN, USERNAME_RE, ageGate, isEmail } from '../../lib/validation';
import { isAgeBlocked, markAgeBlocked } from '../../lib/age-block';
import { AppText, Button, Icon, Screen, TextField } from '../../ui';

type Step = 'birthdate' | 'account' | 'profile';
const STEPS: Step[] = ['birthdate', 'account', 'profile'];
type Availability = 'idle' | 'checking' | 'available' | 'taken' | 'reserved' | 'invalid' | 'error';

const pad = (s: string, n: number) => s.padStart(n, '0');

export default function Signup() {
  const th = useTheme();
  const t = useT();
  const router = useRouter();
  const api = useApi();
  const { register } = useAuth();

  const [step, setStep] = useState<Step>('birthdate');
  const [day, setDay] = useState('');
  const [month, setMonth] = useState('');
  const [year, setYear] = useState('');
  const [birthError, setBirthError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [band, setBand] = useState<'teen' | 'adult' | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [terms, setTerms] = useState(false);
  const [accErrors, setAccErrors] = useState<{ email?: string; password?: string; terms?: string }>(
    {},
  );

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [avail, setAvail] = useState<Availability>('idle');
  const [profErrors, setProfErrors] = useState<{ displayName?: string; username?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void isAgeBlocked().then(setBlocked);
  }, []);

  const birthIso = useMemo(
    () => `${pad(year.trim(), 4)}-${pad(month.trim(), 2)}-${pad(day.trim(), 2)}`,
    [day, month, year],
  );

  // Username availability: debounced, and only the latest request may update the state.
  const uname = username.trim().toLowerCase();
  useEffect(() => {
    if (step !== 'profile') return;
    if (!uname) {
      setAvail('idle');
      return;
    }
    if (!USERNAME_RE.test(uname)) {
      setAvail('invalid');
      return;
    }
    const ctl = new AbortController();
    setAvail('checking');
    const timer = setTimeout(() => {
      api.profile.usernameAvailable(uname, { signal: ctl.signal }).then(
        (r) => {
          if (!ctl.signal.aborted)
            setAvail(
              r.available
                ? 'available'
                : r.reason === 'reserved'
                  ? 'reserved'
                  : r.reason === 'invalid'
                    ? 'invalid'
                    : 'taken',
            );
        },
        () => {
          if (!ctl.signal.aborted) setAvail('error');
        },
      );
    }, 400);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [uname, step, api]);

  const nextFromBirth = async () => {
    if (blocked) return;
    const g = ageGate(birthIso);
    if (!g.ok) {
      if (g.reason === 'too_young') {
        await markAgeBlocked();
        setBlocked(true);
        setBirthError(null);
        return;
      }
      setBirthError(g.reason === 'future' ? t('signup.birth.future') : t('signup.birth.invalid'));
      return;
    }
    setBirthError(null);
    setBand(g.band);
    setStep('account');
  };

  const nextFromAccount = () => {
    const e: typeof accErrors = {};
    if (!isEmail(email)) e.email = t('signup.account.emailInvalid');
    if (password.length < PASSWORD_MIN)
      e.password = t('signup.account.passwordShort', { min: PASSWORD_MIN });
    if (!terms) e.terms = t('signup.account.termsRequired');
    setAccErrors(e);
    if (!Object.keys(e).length) setStep('profile');
  };

  const submit = async () => {
    const e: typeof profErrors = {};
    if (!displayName.trim()) e.displayName = t('signup.profile.nameRequired');
    if (!USERNAME_RE.test(uname)) e.username = t('signup.profile.usernameInvalid');
    else if (avail === 'taken') e.username = t('signup.profile.usernameTaken');
    else if (avail === 'reserved') e.username = t('signup.profile.usernameReserved');
    setProfErrors(e);
    setFormError(null);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      await register({
        email: email.trim(),
        password,
        username: uname,
        displayName: displayName.trim(),
        birthDate: birthIso,
      });
      // The auth gate moves a signed-in account with an unfinished profile to onboarding.
    } catch (err) {
      const fe = fieldErrors(err);
      if (err instanceof ApiError && err.code === 'unprocessable') {
        await markAgeBlocked();
        setBlocked(true);
      } else if (err instanceof ApiError && err.code === 'conflict') {
        setProfErrors({ username: t('signup.profile.usernameTaken') });
        setFormError(errorMessage(err, t));
      } else {
        setProfErrors({
          ...(fe['displayName'] ? { displayName: fe['displayName'] } : {}),
          ...(fe['username'] ? { username: fe['username'] } : {}),
        });
        if (fe['email'] || fe['password'] || fe['birthDate']) {
          setAccErrors({
            ...(fe['email'] ? { email: fe['email'] } : {}),
            ...(fe['password'] ? { password: fe['password'] } : {}),
          });
          setStep(fe['birthDate'] ? 'birthdate' : 'account');
        }
        setFormError(errorMessage(err, t));
      }
    } finally {
      setBusy(false);
    }
  };

  if (blocked) {
    return (
      <Screen scroll>
        <AppText variant="title" header style={{ marginBottom: th.space[3] }}>
          {t('signup.birth.blocked')}
        </AppText>
        <AppText variant="body" tone="muted" accessibilityLiveRegion="polite">
          {t('signup.birth.tooYoung', { min: MIN_AGE_YEARS })}
        </AppText>
      </Screen>
    );
  }

  const availText: Partial<Record<Availability, string>> = {
    checking: t('signup.profile.usernameChecking'),
    available: t('signup.profile.usernameOk', { username: uname }),
    taken: t('signup.profile.usernameTaken'),
    reserved: t('signup.profile.usernameReserved'),
    invalid: t('signup.profile.usernameInvalid'),
  };
  const idx = STEPS.indexOf(step) + 1;

  return (
    <Screen scroll>
      <AppText variant="caption" tone="subtle" accessibilityLiveRegion="polite">
        {t('signup.step', { current: idx, total: STEPS.length })}
      </AppText>
      <AppText variant="title" header style={{ marginBottom: th.space[4] }}>
        {t(`signup.step.${step}`)}
      </AppText>

      {step === 'birthdate' ? (
        <View>
          <AppText variant="body" tone="muted" style={{ marginBottom: th.space[4] }}>
            {t('signup.birth.body', { min: MIN_AGE_YEARS })}
          </AppText>
          <View
            accessibilityRole="none"
            accessibilityLabel={t('signup.birth.group')}
            style={{ flexDirection: 'row', gap: th.space[3] }}
          >
            <View style={{ flex: 1 }}>
              <TextField
                label={t('signup.birth.day')}
                value={day}
                onChangeText={(v) => setDay(v.replace(/\D/g, ''))}
                keyboardType="number-pad"
                maxLength={2}
                placeholder="DD"
              />
            </View>
            <View style={{ flex: 1 }}>
              <TextField
                label={t('signup.birth.month')}
                value={month}
                onChangeText={(v) => setMonth(v.replace(/\D/g, ''))}
                keyboardType="number-pad"
                maxLength={2}
                placeholder="MM"
              />
            </View>
            <View style={{ flex: 1.4 }}>
              <TextField
                label={t('signup.birth.year')}
                value={year}
                onChangeText={(v) => setYear(v.replace(/\D/g, ''))}
                keyboardType="number-pad"
                maxLength={4}
                placeholder="YYYY"
              />
            </View>
          </View>
          {birthError ? (
            <AppText
              variant="caption"
              tone="danger"
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
              style={{ marginBottom: th.space[3] }}
            >
              {birthError}
            </AppText>
          ) : null}
          <Button label={t('common.next')} block onPress={() => void nextFromBirth()} />
        </View>
      ) : null}

      {step === 'account' ? (
        <View>
          {band === 'teen' ? (
            <View
              accessibilityRole="summary"
              style={{
                backgroundColor: th.colors.infoSoft,
                borderRadius: th.radius.md,
                padding: th.space[4],
                marginBottom: th.space[4],
                gap: th.space[1],
              }}
            >
              <AppText variant="bodyStrong" style={{ color: th.colors.info }}>
                {t('signup.teen.title')}
              </AppText>
              <AppText variant="caption" tone="default">
                {t('signup.teen.body')}
              </AppText>
            </View>
          ) : null}
          <TextField
            label={t('signup.account.email')}
            value={email}
            onChangeText={setEmail}
            error={accErrors.email}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            autoCorrect={false}
            required
          />
          <TextField
            label={t('signup.account.password')}
            value={password}
            onChangeText={setPassword}
            error={accErrors.password}
            hint={t('signup.account.passwordHint', { min: PASSWORD_MIN })}
            password
            autoCapitalize="none"
            autoComplete="new-password"
            textContentType="newPassword"
            required
          />
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: terms }}
            accessibilityLabel={t('signup.account.terms')}
            onPress={() => setTerms((v) => !v)}
            style={{
              minHeight: th.targetMin,
              flexDirection: 'row',
              alignItems: 'center',
              gap: th.space[3],
              marginBottom: th.space[2],
            }}
          >
            <View
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                borderWidth: 2,
                borderColor: terms ? th.colors.primary : th.colors.borderStrong,
                backgroundColor: terms ? th.colors.primary : 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {terms ? <Icon name="check" size={16} color={th.colors.onPrimary} /> : null}
            </View>
            <AppText variant="body" style={{ flex: 1 }}>
              {t('signup.account.terms')}
            </AppText>
          </Pressable>
          {accErrors.terms ? (
            <AppText
              variant="caption"
              tone="danger"
              accessibilityRole="alert"
              style={{ marginBottom: th.space[3] }}
            >
              {accErrors.terms}
            </AppText>
          ) : null}
          <View style={{ flexDirection: 'row', gap: th.space[3] }}>
            <Button
              label={t('common.back')}
              variant="secondary"
              onPress={() => setStep('birthdate')}
            />
            <Button label={t('common.next')} style={{ flex: 1 }} onPress={nextFromAccount} />
          </View>
        </View>
      ) : null}

      {step === 'profile' ? (
        <View>
          <TextField
            label={t('signup.profile.displayName')}
            value={displayName}
            onChangeText={setDisplayName}
            error={profErrors.displayName}
            maxLength={60}
            autoComplete="name"
            required
          />
          <TextField
            label={t('signup.profile.username')}
            value={username}
            onChangeText={setUsername}
            error={profErrors.username}
            hint={availText[avail] ?? t('signup.profile.usernameHint')}
            maxLength={30}
            autoCapitalize="none"
            autoCorrect={false}
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
          <View style={{ flexDirection: 'row', gap: th.space[3] }}>
            <Button
              label={t('common.back')}
              variant="secondary"
              onPress={() => setStep('account')}
            />
            <Button
              label={t('signup.submit')}
              style={{ flex: 1 }}
              loading={busy}
              onPress={() => void submit()}
            />
          </View>
        </View>
      ) : null}

      <Button
        label={t('signup.haveAccount')}
        variant="ghost"
        onPress={() => router.replace('/login')}
        style={{ marginTop: th.space[4] }}
      />
    </Screen>
  );
}
