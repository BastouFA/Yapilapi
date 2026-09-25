import React, { useState } from 'react';
import { View } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { useTheme } from '../../theme';
import { useI18n } from '../../i18n';
import { useApi, useAuth } from '../../auth/AuthProvider';
import { usePrivacyRequests, useRequestExport } from '../../data/settings';
import { errorMessage } from '../../lib/errors';
import { formatBytes, shortDate } from '../../lib/format';
import { ApiError } from '@yapilapi/api-client';
import { AppText, Button, Card, ConfirmDialog, Screen, TextField } from '../../ui';

function ExportSection() {
  const th = useTheme();
  const { t, locale } = useI18n();
  const requests = usePrivacyRequests();
  const request = useRequestExport();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const exports = (requests.data?.items ?? []).filter((r) => r.kind === 'export');

  const submit = () => {
    if (!password) {
      setError(t('account.exportPassword'));
      return;
    }
    setError(null);
    request.mutate(password, {
      onSuccess: () => setPassword(''),
      onError: (e) =>
        setError(
          e instanceof ApiError && e.status === 401
            ? t('account.wrongPassword')
            : errorMessage(e, t),
        ),
    });
  };
  return (
    <View style={{ marginTop: th.space[8] }}>
      <AppText variant="heading" header>
        {t('account.export')}
      </AppText>
      <AppText variant="body" tone="muted" style={{ marginVertical: th.space[2] }}>
        {t('account.exportBody')}
      </AppText>
      <TextField
        label={t('account.deletePassword')}
        value={password}
        onChangeText={setPassword}
        password
        autoCapitalize="none"
        autoComplete="current-password"
        error={error}
        hint={t('account.exportPassword')}
      />
      <Button
        label={t('account.exportRequest')}
        variant="secondary"
        loading={request.isPending}
        onPress={submit}
      />
      {request.isSuccess ? (
        <AppText
          variant="body"
          tone="success"
          accessibilityLiveRegion="polite"
          style={{ marginTop: th.space[3] }}
        >
          {t('account.exportReady')}
        </AppText>
      ) : null}
      <AppText variant="caption" tone="muted" style={{ marginTop: th.space[2] }}>
        {t('account.exportAppGap')}
      </AppText>
      <AppText
        variant="label"
        tone="muted"
        style={{ marginTop: th.space[4], marginBottom: th.space[2] }}
        header
      >
        {t('account.exportHistory')}
      </AppText>
      {exports.length === 0 ? (
        <AppText variant="caption" tone="subtle">
          {t('account.exportEmpty')}
        </AppText>
      ) : (
        exports.map((r) => (
          <Card key={r.id} style={{ marginBottom: th.space[2] }}>
            <AppText variant="bodyStrong">{`${shortDate(r.createdAt, locale)} · ${t(`account.exportStatus.${(['completed', 'pending', 'processing', 'rejected', 'cancelled'].includes(r.status) ? r.status : 'pending') as 'completed'}`)}`}</AppText>
            {r.export?.sizeBytes ? (
              <AppText variant="caption" tone="muted">
                {t('account.exportSize', { size: formatBytes(r.export.sizeBytes) })}
              </AppText>
            ) : null}
            {r.export?.expiresAt ? (
              <AppText variant="caption" tone="muted">
                {t('account.exportExpires', { date: shortDate(r.export.expiresAt, locale) })}
              </AppText>
            ) : null}
          </Card>
        ))
      )}
    </View>
  );
}

function DeleteSection() {
  const th = useTheme();
  const { t, locale } = useI18n();
  const api = useApi();
  const { user, refresh } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const del = useMutation({
    mutationFn: () => api.account.requestDeletion(password),
    onSuccess: async () => {
      setPassword('');
      setConfirm(false);
      await refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.account.cancelDeletion(),
    onSuccess: async () => {
      await refresh();
    },
  });
  const scheduled = user?.deletionScheduledFor;

  const start = () => {
    if (!password) {
      setError(t('account.exportPassword'));
      return;
    }
    setError(null);
    setConfirm(true);
  };
  return (
    <View style={{ marginTop: th.space[8] }}>
      <AppText variant="heading" header>
        {t('account.delete')}
      </AppText>
      {scheduled ? (
        <View style={{ gap: th.space[3], marginTop: th.space[2] }}>
          <AppText variant="body" tone="danger" accessibilityLiveRegion="polite">
            {t('account.deleteScheduled', { date: shortDate(scheduled, locale) })}
          </AppText>
          <Button
            label={t('account.deleteCancel')}
            variant="secondary"
            loading={cancel.isPending}
            onPress={() => cancel.mutate()}
          />
          {cancel.isError ? (
            <AppText variant="caption" tone="danger" accessibilityRole="alert">
              {errorMessage(cancel.error, t)}
            </AppText>
          ) : null}
        </View>
      ) : (
        <View>
          <AppText variant="body" tone="muted" style={{ marginVertical: th.space[2] }}>
            {t('account.deleteBody')}
          </AppText>
          <TextField
            label={t('account.deletePassword')}
            value={password}
            onChangeText={setPassword}
            password
            autoCapitalize="none"
            autoComplete="current-password"
            error={error}
          />
          <Button label={t('account.deleteRequest')} variant="danger" onPress={start} />
        </View>
      )}
      <ConfirmDialog
        visible={confirm}
        title={t('account.deleteConfirmTitle')}
        body={t('account.deleteConfirmBody')}
        confirmLabel={t('account.deleteRequest')}
        destructive
        loading={del.isPending}
        onCancel={() => setConfirm(false)}
        onConfirm={() =>
          del.mutate(undefined, {
            onError: (e) => {
              setConfirm(false);
              setError(
                e instanceof ApiError && e.status === 401
                  ? t('account.wrongPassword')
                  : errorMessage(e, t),
              );
            },
          })
        }
      />
    </View>
  );
}

export default function AccountSettings() {
  const th = useTheme();
  const { t } = useI18n();
  const api = useApi();
  const { user } = useAuth();
  const [resent, setResent] = useState<string | null>(null);
  const resend = useMutation({
    mutationFn: () => api.auth.resendVerification(),
    onSuccess: () => setResent(t('account.resent')),
    onError: (e) => setResent(errorMessage(e, t)),
  });
  if (!user) return null;
  return (
    <Screen scroll>
      <Card style={{ gap: th.space[1] }}>
        <AppText variant="label" tone="muted">
          {t('account.email')}
        </AppText>
        <AppText variant="bodyStrong" selectable>
          {user.email}
        </AppText>
        <AppText variant="caption" tone={user.emailVerified ? 'success' : 'warning'}>
          {user.emailVerified ? t('account.verified') : t('account.notVerified')}
        </AppText>
        {!user.emailVerified ? (
          <Button
            label={t('account.resend')}
            variant="secondary"
            compact
            loading={resend.isPending}
            onPress={() => resend.mutate()}
            style={{ alignSelf: 'flex-start', marginTop: th.space[2] }}
          />
        ) : null}
        {resent ? (
          <AppText variant="caption" tone="muted" accessibilityLiveRegion="polite">
            {resent}
          </AppText>
        ) : null}
        <AppText variant="caption" tone="muted" style={{ marginTop: th.space[2] }}>
          {t(`account.ageBand.${user.ageBand}`)}
        </AppText>
      </Card>
      <AppText
        variant="caption"
        tone="muted"
        style={{ marginTop: th.space[4] }}
      >{`${t('account.mfa')}: ${user.mfaEnabled ? t('common.on') : t('common.off')}. ${t('account.mfaOnWeb')}`}</AppText>
      <ExportSection />
      <DeleteSection />
    </Screen>
  );
}
