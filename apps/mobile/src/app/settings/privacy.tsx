import React from 'react';
import { View } from 'react-native';
import type { Preferences } from '@yapilapi/api-client';
import { useTheme } from '../../theme';
import { useT } from '../../i18n';
import { useMe } from '../../auth/AuthProvider';
import { useBlocks, usePreferences, useUnblock, useUpdatePreferences } from '../../data/settings';
import { useProfile, useUpdateProfile } from '../../data/social';
import { errorMessage } from '../../lib/errors';
import {
  AppText,
  Avatar,
  Button,
  ChoiceGroup,
  ErrorView,
  LoadingView,
  Screen,
  SwitchRow,
} from '../../ui';

export default function PrivacySettings() {
  const th = useTheme();
  const t = useT();
  const me = useMe();
  const prefs = usePreferences();
  const update = useUpdatePreferences();
  const profile = useProfile(me.profile.username);
  const updateProfile = useUpdateProfile();
  const blocks = useBlocks();
  const unblock = useUnblock();
  const teen = me.ageBand === 'teen';

  if (prefs.isPending)
    return (
      <Screen>
        <LoadingView />
      </Screen>
    );
  if (prefs.isError)
    return (
      <Screen>
        <ErrorView error={prefs.error} onRetry={() => void prefs.refetch()} />
      </Screen>
    );
  const p = prefs.data;
  const set = (patch: Partial<Preferences>) => update.mutate(patch);
  const err = update.error ?? updateProfile.error;

  return (
    <Screen scroll>
      {teen ? (
        <AppText variant="caption" tone="muted" style={{ marginBottom: th.space[4] }}>
          {t('privacy.teenLocked')}
        </AppText>
      ) : null}
      <SwitchRow
        label={t('privacy.privateAccount')}
        hint={t('privacy.privateAccountHint')}
        value={profile.data?.isPrivate ?? false}
        disabled={teen || !profile.data}
        onChange={(v) => updateProfile.mutate({ isPrivate: v })}
      />
      <ChoiceGroup
        label={t('privacy.whoCanMessage')}
        value={p.whoCanMessage}
        disabled={teen}
        options={(['everyone', 'followers', 'friends', 'nobody'] as const).map((v) => ({
          value: v,
          label: t(`privacy.msg.${v}`),
        }))}
        onChange={(v) => set({ whoCanMessage: v })}
      />
      <ChoiceGroup
        label={t('privacy.defaultVisibility')}
        value={p.defaultPostVisibility}
        options={(['public', 'followers', 'friends', 'private'] as const).map((v) => ({
          value: v,
          label: t(`compose.audience.${v}`),
        }))}
        onChange={(v) => set({ defaultPostVisibility: v })}
      />
      <SwitchRow
        label={t('privacy.discoverable')}
        hint={t('privacy.discoverableHint')}
        value={p.discoverable}
        disabled={teen}
        onChange={(v) => set({ discoverable: v })}
      />
      <SwitchRow
        label={t('privacy.personalization')}
        hint={t('privacy.personalizationHint')}
        value={p.personalization}
        onChange={(v) => set({ personalization: v })}
      />
      <ChoiceGroup
        label={t('privacy.sensitive')}
        value={p.sensitiveContent}
        disabled={teen}
        options={(['hide', 'limit', 'allow'] as const).map((v) => ({
          value: v,
          label: t(`privacy.sensitive.${v}`),
        }))}
        onChange={(v) => set({ sensitiveContent: v })}
      />
      {err ? (
        <AppText
          variant="caption"
          tone="danger"
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={{ marginBottom: th.space[3] }}
        >{`${t('privacy.saveFailed')} ${errorMessage(err, t)}`}</AppText>
      ) : null}

      <AppText
        variant="heading"
        header
        style={{ marginTop: th.space[4], marginBottom: th.space[2] }}
      >
        {t('privacy.blocked')}
      </AppText>
      {blocks.isPending ? (
        <LoadingView />
      ) : blocks.isError ? (
        <ErrorView error={blocks.error} onRetry={() => void blocks.refetch()} />
      ) : blocks.data.items.length === 0 ? (
        <AppText variant="body" tone="muted">
          {t('privacy.blockedEmpty')}
        </AppText>
      ) : (
        blocks.data.items.map((u) => (
          <View
            key={u.id}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: th.space[3],
              minHeight: th.targetMin + 12,
            }}
          >
            <Avatar name={u.displayName} uri={u.avatarUrl} size={36} />
            <AppText
              variant="body"
              style={{ flex: 1 }}
              numberOfLines={1}
            >{`${u.displayName} (@${u.username})`}</AppText>
            <Button
              compact
              variant="secondary"
              label={t('privacy.unblock')}
              accessibilityLabel={`${t('privacy.unblock')} @${u.username}`}
              loading={unblock.isPending && unblock.variables?.id === u.id}
              onPress={() => unblock.mutate(u)}
            />
          </View>
        ))
      )}
    </Screen>
  );
}
