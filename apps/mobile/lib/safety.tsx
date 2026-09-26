import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ApiError, type VerificationStatus } from '../../../packages/api-client/src/index';
import { client, errorMessage } from './api';
import { useT } from './i18n';
import { useSession } from './session';
import { radius, space } from './theme';
import { Button, Card, Field, Icon, Loading, Notice, Title, useColors } from './ui';

/** True for the API's "confirm your email or phone first" refusal. */
export const isVerificationError = (e: unknown) => e instanceof ApiError && e.code === 'verification_required';

/** A calm prompt with a way to confirm, shown when posting publicly or messaging someone new needs it. */
export function VerifyPrompt({ action }: { action: 'post' | 'message' }) {
  const { t } = useT();
  const c = useColors();
  return (
    <Notice title={t('m.verify.prompt.title')}>
      <View style={{ gap: space[2] }}>
        <Text style={{ lineHeight: 20, color: c.ink }}>{t(action === 'post' ? 'm.verify.prompt.post' : 'm.verify.prompt.message')}</Text>
        <Button
          size="sm"
          variant="secondary"
          label={t('m.verify.prompt.action')}
          onPress={() => router.push('/settings')}
          style={{ alignSelf: 'flex-start' }}
        />
      </View>
    </Notice>
  );
}

/**
 * Covers media that automated checks marked sensitive. Place it over the
 * blurred (or hidden) media; only its button takes touches.
 */
export function SensitiveCover({ onReveal, compact }: { onReveal: () => void; compact?: boolean }) {
  const { t } = useT();
  return (
    <View style={[StyleSheet.absoluteFill, st.cover]} pointerEvents="box-none">
      <Icon name="eye-off-outline" size={compact ? 18 : 26} color="#FFFFFF" />
      <Text style={{ color: '#FFFFFF', fontWeight: '700', fontSize: compact ? 13 : 15, textAlign: 'center' }}>{t('m.sensitive.label')}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('m.sensitive.viewA11y')}
        onPress={onReveal}
        hitSlop={8}
        style={({ pressed }) => [st.view, pressed && { opacity: 0.8 }]}
      >
        <Text style={{ color: '#FFFFFF', fontWeight: '700', fontSize: 14 }}>{t('m.sensitive.view')}</Text>
      </Pressable>
    </View>
  );
}

/** Where a removed or withheld chat attachment was. */
export function UnavailableMedia({ tint }: { tint: string }) {
  const { t } = useT();
  return <Text style={{ color: tint, fontSize: 14, fontStyle: 'italic', opacity: 0.85 }}>{t('m.media.unavailable')}</Text>;
}

/**
 * Email and phone confirmation (Settings). A confirmed email or phone number
 * unlocks posting publicly and messaging people who aren't friends yet.
 */
export function VerificationCard() {
  const c = useColors();
  const { t } = useT();
  const { refresh } = useSession();
  const [status, setStatus] = useState<VerificationStatus | null>(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'idle' | 'code'>('idle');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client()
      .then((api) => api.verification.status())
      .then((s) => {
        setStatus(s);
        if (s.phone && !s.phone.verified) setPhone(s.phone.number);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!status) return error ? <Notice tone="danger">{error}</Notice> : <Loading />;
  const phoneVerified = !!status.phone?.verified;
  const line = (label: string, value: string) => (
    <View style={{ gap: 2 }}>
      <Text style={{ color: c.ink, fontWeight: '700', fontSize: 15 }}>{label}</Text>
      <Text style={{ color: c.inkMuted, fontSize: 14 }}>{value}</Text>
    </View>
  );

  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={status.verified ? t('m.verify.done') : status.required ? t('m.verify.required') : t('m.verify.optional')}>{t('m.verify.title')}</Title>
      {note ? <Notice>{note}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}

      {line(t('m.verify.email'), `${status.email.address} · ${status.email.verified ? t('m.verify.confirmed') : t('m.verify.notConfirmed')}`)}
      {!status.email.verified ? (
        <Button
          size="sm"
          variant="secondary"
          label={t('m.verify.resendEmail')}
          disabled={busy}
          style={{ alignSelf: 'flex-start' }}
          onPress={() =>
            run(async () => {
              await (await client()).auth.resendVerification();
              setNote(t('m.verify.emailSent'));
            })
          }
        />
      ) : null}

      {line(
        t('m.verify.phone'),
        status.phone ? `${status.phone.number} · ${phoneVerified ? t('m.verify.confirmed') : t('m.verify.notConfirmed')}` : t('m.verify.noPhone'),
      )}

      {!phoneVerified && step === 'idle' ? (
        <View style={{ gap: space[2] }}>
          <Field
            label={t('m.verify.phoneLabel')}
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            textContentType="telephoneNumber"
            autoComplete="tel"
            placeholder="+44 7700 900123"
            maxLength={32}
          />
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.verify.phoneHint')}</Text>
          <Button
            size="sm"
            label={t('m.verify.sendCode')}
            disabled={busy || phone.trim().length < 6}
            style={{ alignSelf: 'flex-start' }}
            onPress={() =>
              run(async () => {
                const api = await client();
                setStatus(await api.verification.setPhone(phone));
                await api.verification.sendCode();
                setCode('');
                setStep('code');
              })
            }
          />
        </View>
      ) : null}

      {!phoneVerified && step === 'code' ? (
        <View style={{ gap: space[2] }}>
          <Text style={{ color: c.ink, lineHeight: 20 }}>{t('m.verify.codeSent', { phone: status.phone?.number ?? '' })}</Text>
          <Field
            label={t('m.verify.codeLabel')}
            value={code}
            onChangeText={(v) => setCode(v.replace(/\D/g, ''))}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="sms-otp"
            maxLength={10}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            <Button
              size="sm"
              label={t('m.verify.confirm')}
              disabled={busy || code.length < 4}
              onPress={() =>
                run(async () => {
                  setStatus(await (await client()).verification.verifyPhone(code));
                  setStep('idle');
                  setNote(t('m.verify.phoneConfirmed'));
                  await refresh();
                })
              }
            />
            <Button
              size="sm"
              variant="ghost"
              label={t('m.verify.newCode')}
              disabled={busy}
              onPress={() =>
                run(async () => {
                  await (await client()).verification.sendCode();
                  setNote(t('m.verify.newCodeSent'));
                })
              }
            />
            <Button size="sm" variant="ghost" label={t('m.verify.changeNumber')} disabled={busy} onPress={() => setStep('idle')} />
          </View>
        </View>
      ) : null}

      {status.phone ? (
        <Button
          size="sm"
          variant="ghost"
          label={t('m.verify.remove')}
          disabled={busy}
          style={{ alignSelf: 'flex-start' }}
          onPress={() =>
            run(async () => {
              setStatus(await (await client()).verification.removePhone());
              setPhone('');
              setStep('idle');
              setNote(t('m.verify.phoneRemoved'));
              await refresh();
            })
          }
        />
      ) : null}
    </Card>
  );
}

const st = StyleSheet.create({
  cover: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[2],
    padding: space[3],
    backgroundColor: 'rgba(7, 8, 14, 0.55)',
  },
  view: {
    minHeight: 36,
    paddingHorizontal: space[4],
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.7)',
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
