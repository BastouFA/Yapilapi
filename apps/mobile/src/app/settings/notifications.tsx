import React, { useEffect, useState } from 'react';
import { Linking, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useTheme } from '../../theme';
import { useT } from '../../i18n';
import { useApi } from '../../auth/AuthProvider';
import { usePushTokens } from '../../data/settings';
import { qk } from '../../data/keys';
import {
  disablePush,
  enablePush,
  hasStoredPushToken,
  pushState,
  type PushResult,
  type PushState,
} from '../../push';
import { AppText, Button, Screen } from '../../ui';

export default function PushSettings() {
  const th = useTheme();
  const t = useT();
  const api = useApi();
  const qc = useQueryClient();
  const tokens = usePushTokens();
  const [state, setState] = useState<PushState | null>(null);
  const [registered, setRegistered] = useState(false);
  const [failure, setFailure] = useState<Extract<PushResult, { ok: false }>['reason'] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setState(await pushState());
    setRegistered(await hasStoredPushToken());
  };
  useEffect(() => {
    void refresh();
  }, []);

  const turnOn = async () => {
    setBusy(true);
    setFailure(null);
    const r = await enablePush(api);
    if (!r.ok) setFailure(r.reason);
    await refresh();
    void qc.invalidateQueries({ queryKey: qk.pushTokens() });
    setBusy(false);
  };
  const turnOff = async () => {
    setBusy(true);
    await disablePush(api);
    await refresh();
    void qc.invalidateQueries({ queryKey: qk.pushTokens() });
    setBusy(false);
  };

  const failureText =
    failure === 'denied'
      ? t('push.denied')
      : failure === 'unsupported'
        ? t('push.unsupported')
        : failure === 'no_project'
          ? t('push.noProject')
          : failure
            ? t('push.failed')
            : null;
  return (
    <Screen scroll>
      <AppText variant="body" tone="muted" style={{ marginBottom: th.space[4] }}>
        {t('push.body')}
      </AppText>
      {state === 'unsupported' ? (
        <AppText variant="body" tone="muted">
          {t('push.unsupported')}
        </AppText>
      ) : registered ? (
        <View style={{ gap: th.space[3] }}>
          <AppText variant="body" tone="success" accessibilityLiveRegion="polite">
            {t('push.enabled')}
          </AppText>
          <Button
            label={t('push.disable')}
            variant="secondary"
            loading={busy}
            onPress={() => void turnOff()}
          />
        </View>
      ) : (
        <View style={{ gap: th.space[3] }}>
          {state === 'denied' ? (
            <AppText variant="body" tone="muted">
              {t('push.denied')}
            </AppText>
          ) : null}
          {state === 'denied' ? (
            <Button
              label={t('settings.title')}
              variant="secondary"
              onPress={() => void Linking.openSettings()}
            />
          ) : (
            <Button label={t('push.enable')} loading={busy} onPress={() => void turnOn()} />
          )}
        </View>
      )}
      {failureText && state !== 'denied' ? (
        <AppText
          variant="body"
          tone="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={{ marginTop: th.space[3] }}
        >
          {failureText}
        </AppText>
      ) : null}
      <AppText
        variant="heading"
        header
        style={{ marginTop: th.space[8], marginBottom: th.space[2] }}
      >
        {t('push.devices')}
      </AppText>
      {tokens.isPending ? (
        <AppText variant="caption" tone="muted">
          {t('common.loading')}
        </AppText>
      ) : tokens.isError ? (
        <Button
          label={t('common.retry')}
          variant="secondary"
          compact
          onPress={() => void tokens.refetch()}
        />
      ) : tokens.data.items.length === 0 ? (
        <AppText variant="body" tone="muted">
          {t('push.devicesEmpty')}
        </AppText>
      ) : (
        tokens.data.items.map((d) => (
          <AppText key={d.id} variant="body">
            {t('push.deviceRow', { platform: d.platform, tail: d.tokenTail })}
          </AppText>
        ))
      )}
    </Screen>
  );
}
