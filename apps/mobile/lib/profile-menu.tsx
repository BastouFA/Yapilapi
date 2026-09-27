import { useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { REPORT_REASONS } from '../../../packages/shared/src/constants';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import type { Profile } from '../../../packages/shared/src/types';
import { client, errorMessage } from './api';
import { useT } from './i18n';
import { Sheet } from './post-edit';
import { radius, space } from './theme';
import { Icon, useColors, type IconName } from './ui';

const REASON_KEYS: Record<(typeof REPORT_REASONS)[number], MessageKey> = {
  spam: 'postList.reason.spam',
  harassment: 'postList.reason.harassment',
  hate: 'postList.reason.hate',
  violence: 'postList.reason.violence',
  nudity: 'postList.reason.nudity',
  self_harm: 'postList.reason.selfHarm',
  impersonation: 'postList.reason.impersonation',
  fraud: 'postList.reason.fraud',
  minor_safety: 'postList.reason.minorSafety',
  other: 'postList.reason.other',
};

/** One line in a sheet: an icon, a label, 48 high. */
export function SheetItem({
  icon,
  label,
  onPress,
  danger,
  disabled,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  const c = useColors();
  const color = danger ? c.danger : c.ink;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[3],
        minHeight: 48,
        paddingHorizontal: space[2],
        borderRadius: radius.md,
        backgroundColor: pressed ? c.surfaceSunken : 'transparent',
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Icon name={icon} size={20} color={color} />
      <Text style={{ color, fontSize: 15, fontWeight: '600', flex: 1 }}>{label}</Text>
    </Pressable>
  );
}

/**
 * More for someone else's profile: add or accept them as a friend, mute, block, or report them.
 * `onChanged` reloads the profile; `onMessage` shows what happened ("Muted", the report's thanks).
 */
export function ProfileMenu({
  profile,
  open,
  onClose,
  onChanged,
  onMessage,
}: {
  profile: Profile;
  open: boolean;
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  onMessage: (text: string, tone?: 'info' | 'danger') => void;
}) {
  const { t } = useT();
  const [reporting, setReporting] = useState(false);
  const rel = profile.relationship;

  const close = () => {
    setReporting(false);
    onClose();
  };

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    close();
    try {
      await fn();
      await onChanged();
      if (done) onMessage(done);
    } catch (e) {
      onMessage(errorMessage(e), 'danger');
    }
  };

  const block = () => {
    close();
    // After the sheet has gone: iOS won't show an alert over a sheet that is closing.
    setTimeout(() => confirmBlock(), 400);
  };
  const confirmBlock = () => {
    Alert.alert(t('m.profile.blockTitle', { name: profile.displayName }), t('m.profile.blockBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('profile.block'),
        style: 'destructive',
        onPress: () => void act(async () => (await client()).users.block(profile.id), t('m.profile.blocked', { name: profile.displayName })),
      },
    ]);
  };

  const report = async (reason: string) => {
    close();
    try {
      const r = await (await client()).reports.create({ targetType: 'user', targetId: profile.id, reason });
      onMessage(r.message);
    } catch (e) {
      onMessage(errorMessage(e), 'danger');
    }
  };

  return (
    <Sheet visible={open} title={reporting ? t('m.profile.reportTitle', { name: profile.displayName }) : profile.displayName} onClose={close}>
      {reporting ? (
        <View style={{ gap: 2 }}>
          {REPORT_REASONS.map((r) => (
            <SheetItem key={r} icon="flag-outline" label={t(REASON_KEYS[r])} onPress={() => void report(r)} />
          ))}
          <SheetItem icon="arrow-back" label={t('m.common.back')} onPress={() => setReporting(false)} />
        </View>
      ) : (
        <View style={{ gap: 2 }}>
          {rel.blocked ? null : rel.friends ? (
            <SheetItem
              icon="person-remove-outline"
              label={t('m.profile.unfriend')}
              onPress={() => void act(async () => (await client()).users.unfriend(profile.id), t('m.profile.unfriended', { name: profile.displayName }))}
            />
          ) : rel.friendRequest === 'sent' ? (
            <SheetItem icon="time-outline" label={t('profile.requestSent')} disabled onPress={() => {}} />
          ) : (
            <SheetItem
              icon="person-add-outline"
              label={rel.friendRequest === 'received' ? t('profile.acceptFriend') : t('profile.addFriend')}
              onPress={() => void act(async () => (await client()).users.friendRequest(profile.id))}
            />
          )}
          <SheetItem
            icon={rel.muted ? 'volume-high-outline' : 'volume-mute-outline'}
            label={rel.muted ? t('m.profile.unmute') : t('m.profile.mute')}
            onPress={() =>
              void act(
                async () => {
                  const api = await client();
                  await (rel.muted ? api.raw.del(`/v1/users/${profile.id}/mute`) : api.users.mute(profile.id));
                },
                rel.muted ? t('m.profile.unmuted', { name: profile.displayName }) : t('m.profile.muted', { name: profile.displayName }),
              )
            }
          />
          {rel.blocked ? (
            <SheetItem
              icon="lock-open-outline"
              label={t('profile.unblock')}
              onPress={() => void act(async () => (await client()).users.unblock(profile.id), t('m.profile.unblocked', { name: profile.displayName }))}
            />
          ) : (
            <SheetItem icon="ban-outline" label={t('profile.block')} danger onPress={block} />
          )}
          <SheetItem icon="flag-outline" label={t('reel.report')} danger onPress={() => setReporting(true)} />
        </View>
      )}
    </Sheet>
  );
}
