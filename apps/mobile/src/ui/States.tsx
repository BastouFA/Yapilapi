import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { ApiError } from '@yapilapi/api-client';
import { useTheme } from '../theme';
import { useT } from '../i18n';
import { errorMessage, isOffline } from '../lib/errors';
import { AppText } from './Text';
import { Button } from './Button';

export function LoadingView({ label }: { label?: string }) {
  const th = useTheme();
  const t = useT();
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label ?? t('common.loading')}
      accessibilityLiveRegion="polite"
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: th.space[8] }}
    >
      <ActivityIndicator size="large" color={th.colors.primary} />
    </View>
  );
}

/** A failed load: says what happened in plain language and always offers a retry (offline gets its own wording). */
export function ErrorView({
  error,
  onRetry,
  message,
}: {
  error?: unknown;
  onRetry?: () => void;
  message?: string;
}) {
  const th = useTheme();
  const t = useT();
  const text =
    message ??
    (error === undefined
      ? t('state.loadFailed')
      : isOffline(error)
        ? t('state.offlineRetry')
        : errorMessage(error, t));
  const notFound = error instanceof ApiError && error.status === 404;
  return (
    <View
      accessibilityRole="alert"
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: th.space[8],
        gap: th.space[4],
      }}
    >
      <AppText variant="body" tone="muted" style={{ textAlign: 'center' }}>
        {text}
      </AppText>
      {onRetry && !notFound ? (
        <Button label={t('common.retry')} variant="secondary" onPress={onRetry} />
      ) : null}
    </View>
  );
}

/** Honest empty state: what is missing and, when there is one, the next useful step. */
export function EmptyView({
  title,
  message,
  actionLabel,
  onAction,
}: {
  title?: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const th = useTheme();
  return (
    <View
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        padding: th.space[8],
        gap: th.space[3],
      }}
    >
      {title ? (
        <AppText variant="heading" style={{ textAlign: 'center' }} header>
          {title}
        </AppText>
      ) : null}
      <AppText variant="body" tone="muted" style={{ textAlign: 'center' }}>
        {message}
      </AppText>
      {actionLabel && onAction ? <Button label={actionLabel} onPress={onAction} /> : null}
    </View>
  );
}

export function Banner({
  text,
  tone = 'info',
  actionLabel,
  onAction,
}: {
  text: string;
  tone?: 'info' | 'warning' | 'danger';
  actionLabel?: string;
  onAction?: () => void;
}) {
  const th = useTheme();
  const bg =
    tone === 'warning'
      ? th.colors.warningSoft
      : tone === 'danger'
        ? th.colors.dangerSoft
        : th.colors.infoSoft;
  const fg =
    tone === 'warning' ? th.colors.warning : tone === 'danger' ? th.colors.danger : th.colors.info;
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{
        backgroundColor: bg,
        paddingHorizontal: th.space[4],
        paddingVertical: th.space[2],
        flexDirection: 'row',
        alignItems: 'center',
        gap: th.space[3],
      }}
    >
      <AppText variant="caption" style={{ color: fg, flex: 1 }}>
        {text}
      </AppText>
      {actionLabel && onAction ? (
        <Button label={actionLabel} variant="ghost" compact onPress={onAction} />
      ) : null}
    </View>
  );
}

/** Shown above cached content when the server could not be reached. */
export function OfflineBanner({ visible }: { visible: boolean }) {
  const t = useT();
  return visible ? <Banner tone="warning" text={t('state.offline')} /> : null;
}
