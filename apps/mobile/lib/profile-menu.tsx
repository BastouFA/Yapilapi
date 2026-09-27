import { Alert, View } from 'react-native';
import type { Profile } from '../../../packages/shared/src/types';
import { client, errorMessage } from './api';
import { useT } from './i18n';
import { useReport } from './report';
import { BottomSheet, SheetItem } from './ui';

/**
 * More for someone else's profile: add or accept them as a friend, mute, block, or report them.
 * `onChanged` reloads the profile; `onMessage` shows what happened ("Muted"). Reporting opens the
 * shared report sheet, which says what happens next itself.
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
  const rel = profile.relationship;
  // Reporting from the shared sheet; blocking from there too reloads the profile.
  const reporter = useReport({ onBlocked: () => void onChanged() });

  const close = () => onClose();

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

  const report = () => {
    close();
    // After the menu has gone: iOS can't show a sheet over one that is closing.
    setTimeout(() => reporter.open({ type: 'user', id: profile.id, authorId: rel.blocked ? undefined : profile.id, authorName: profile.displayName }), 400);
  };

  return (
    <>
      <BottomSheet visible={open} title={profile.displayName} onClose={close}>
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
          <SheetItem icon="flag-outline" label={t('reel.report')} danger onPress={report} />
        </View>
      </BottomSheet>
      {reporter.sheet}
    </>
  );
}
