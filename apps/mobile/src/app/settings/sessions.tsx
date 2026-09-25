import React, { useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '../../theme';
import { useI18n } from '../../i18n';
import { useApi, useAuth } from '../../auth/AuthProvider';
import { useRevokeSession, useSessions } from '../../data/settings';
import { relativeTime } from '../../lib/format';
import { errorMessage } from '../../lib/errors';
import {
  AppText,
  Button,
  Card,
  ConfirmDialog,
  EmptyView,
  ErrorView,
  LoadingView,
  Screen,
} from '../../ui';

export default function Sessions() {
  const th = useTheme();
  const { t, locale } = useI18n();
  const api = useApi();
  const { logout } = useAuth();
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const [confirmAll, setConfirmAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sessions.isPending)
    return (
      <Screen>
        <LoadingView />
      </Screen>
    );
  if (sessions.isError)
    return (
      <Screen>
        <ErrorView error={sessions.error} onRetry={() => void sessions.refetch()} />
      </Screen>
    );
  const items = sessions.data.items;
  const others = items.filter((s) => !s.current);

  return (
    <Screen scroll>
      <AppText variant="body" tone="muted" style={{ marginBottom: th.space[4] }}>
        {t('sessions.body')}
      </AppText>
      {items.length === 0 ? (
        <EmptyView message={t('sessions.empty')} />
      ) : (
        items.map((s) => (
          <Card key={s.id} style={{ marginBottom: th.space[3], gap: th.space[1] }}>
            <AppText variant="bodyStrong">
              {s.deviceLabel ?? s.userAgent ?? t('sessions.unknownDevice')}
            </AppText>
            {s.current ? (
              <AppText variant="caption" tone="success">
                {t('sessions.current')}
              </AppText>
            ) : null}
            <AppText variant="caption" tone="muted">
              {t('sessions.lastActive', { time: relativeTime(s.lastSeenAt, locale) })}
            </AppText>
            <AppText variant="caption" tone="subtle">
              {t('sessions.signedIn', { time: relativeTime(s.createdAt, locale) })}
            </AppText>
            {!s.current ? (
              <View style={{ alignSelf: 'flex-start', marginTop: th.space[2] }}>
                <Button
                  compact
                  variant="secondary"
                  label={t('sessions.revoke')}
                  accessibilityLabel={`${t('sessions.revoke')}: ${s.deviceLabel ?? t('sessions.unknownDevice')}`}
                  loading={revoke.isPending && revoke.variables === s.id}
                  onPress={() =>
                    revoke.mutate(s.id, { onError: (e) => setError(errorMessage(e, t)) })
                  }
                />
              </View>
            ) : null}
          </Card>
        ))
      )}
      {error ? (
        <AppText variant="caption" tone="danger" accessibilityRole="alert">
          {error}
        </AppText>
      ) : null}
      {others.length ? (
        <Button
          label={t('sessions.revokeAll')}
          variant="danger"
          block
          onPress={() => setConfirmAll(true)}
          style={{ marginTop: th.space[4] }}
        />
      ) : null}
      <ConfirmDialog
        visible={confirmAll}
        title={t('sessions.revokeAllTitle')}
        body={t('sessions.revokeAllBody')}
        confirmLabel={t('sessions.revokeAll')}
        destructive
        onCancel={() => setConfirmAll(false)}
        onConfirm={() => {
          setConfirmAll(false);
          void api.auth
            .logoutAll()
            .catch(() => undefined)
            .finally(() => void logout());
        }}
      />
    </Screen>
  );
}
