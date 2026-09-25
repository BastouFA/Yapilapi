import React, { useState } from 'react';
import { useRouter } from 'expo-router';
import { ApiError } from '@yapilapi/api-client';
import { useTheme } from '../../theme';
import { useT } from '../../i18n';
import { useAuth } from '../../auth/AuthProvider';
import { getPendingMfa, setPendingMfa } from '../../auth/pending-mfa';
import { errorMessage } from '../../lib/errors';
import { AppText, Button, Screen, TextField } from '../../ui';

export default function Mfa() {
  const th = useTheme();
  const t = useT();
  const router = useRouter();
  const { verifyMfa } = useAuth();
  const [recovery, setRecovery] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const token = getPendingMfa();
    if (!token) {
      setError(t('mfa.expired'));
      return;
    }
    const v = value.trim();
    if (!recovery && !/^\d{6}$/.test(v)) {
      setError(t('mfa.body'));
      return;
    }
    if (recovery && v.length < 5) {
      setError(t('error.validation'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await verifyMfa(token, recovery ? { recoveryCode: v } : { code: v });
      setPendingMfa(null);
    } catch (e) {
      // A 401 on the challenge means the code (or the challenge itself) was rejected.
      setError(e instanceof ApiError && e.status === 401 ? t('mfa.expired') : errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll>
      <AppText variant="body" tone="muted" style={{ marginBottom: th.space[4] }}>
        {t('mfa.body')}
      </AppText>
      <TextField
        label={recovery ? t('mfa.recoveryCode') : t('mfa.code')}
        value={value}
        onChangeText={setValue}
        error={error}
        keyboardType={recovery ? 'default' : 'number-pad'}
        maxLength={recovery ? 30 : 6}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        onSubmitEditing={() => void submit()}
        required
      />
      <Button label={t('mfa.submit')} block loading={busy} onPress={() => void submit()} />
      <Button
        label={recovery ? t('mfa.useCode') : t('mfa.useRecovery')}
        variant="ghost"
        onPress={() => {
          setRecovery((r) => !r);
          setValue('');
          setError(null);
        }}
        style={{ marginTop: th.space[3] }}
      />
      <Button
        label={t('common.cancel')}
        variant="ghost"
        onPress={() => {
          setPendingMfa(null);
          router.back();
        }}
      />
    </Screen>
  );
}
