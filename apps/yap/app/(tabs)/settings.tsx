import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, ScrollView, Text, View } from 'react-native';
import { useConfirmLogout } from '../../../mobile/lib/account-menu';
import { TranscribeVoiceSwitch } from '../../../mobile/lib/ai-helpers';
import { useT } from '../../../mobile/lib/i18n';
import { registerForPush } from '../../../mobile/lib/push';
import {
  APP_VERSION,
  AppearanceCard,
  AppLanguage,
  Choices,
  LegalLinks,
  ProfileSummary,
  QuietHours,
  SettingsGroup,
  SettingsLinkRow,
  useInteractions,
} from '../../../mobile/lib/settings-extra';
import { BlockedAccounts } from '../../../mobile/lib/settings-more';
import { Translation } from '../../../mobile/lib/settings-sections';
import { space } from '../../../mobile/lib/theme';
import { Button, Card, Icon, Loading, Notice, SwitchRow, Title, useColors } from '../../../mobile/lib/ui';
import { openInYapilapi } from '../../lib/elsewhere';

/** Who can message you, read receipts and transcripts of your voice messages: the messaging half of YAPILAPI's privacy settings (the same ones). */
function MessagePrivacy() {
  const { t } = useT();
  const { settings, error, save } = useInteractions();
  return (
    <Card style={{ gap: space[4] }}>
      <Title sub={t('st.who.friendsAlways')}>{t('st.privacy.title')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {settings ? (
        <>
          <Choices
            label={t('st.who.message')}
            hint={t('st.who.messageHint')}
            value={settings.messagesFrom}
            onChange={(v) => void save({ messagesFrom: v })}
            options={[
              { id: 'everyone', label: t('st.who.everyone') },
              { id: 'following', label: t('st.who.following') },
              { id: 'friends', label: t('st.who.friends') },
            ]}
          />
          <SwitchRow
            label={t('st.who.readReceipts')}
            hint={t('st.who.readReceiptsHint')}
            value={settings.readReceipts}
            onValueChange={(v) => void save({ readReceipts: v })}
          />
          <TranscribeVoiceSwitch />
        </>
      ) : !error ? (
        <Loading />
      ) : null}
    </Card>
  );
}

/** Turn on notifications on this phone: Yap registers as Yap, so it gets chats and calls only. */
function PushOnThisPhone() {
  const c = useColors();
  const { t } = useT();
  const [note, setNote] = useState<string | null>(null);
  return (
    <Card style={{ gap: space[3] }}>
      <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>{t('yapApp.push.phone')}</Text>
      <Button
        label={t('m.push.enable')}
        icon="notifications-outline"
        variant="secondary"
        onPress={async () => {
          const r = await registerForPush().catch(() => 'unavailable' as const);
          setNote(r === 'registered' ? t('m.push.on') : r === 'denied' ? t('m.push.blocked') : t('m.push.unavailable'));
        }}
      />
      {note ? <Notice>{note}</Notice> : null}
    </Card>
  );
}

/**
 * Settings: your photo and name (Edit profile), who can message you and read receipts, blocked
 * people, notifications on this phone and quiet hours, language and translation, and appearance; everything else
 * (posts, the rest of privacy, security) opens in YAPILAPI. Your data and deleting your account are
 * here too, as the stores ask of any app you can sign up in.
 */
export default function Settings() {
  const c = useColors();
  const { t } = useT();
  const confirmLogout = useConfirmLogout();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
      keyboardShouldPersistTaps="handled"
    >
      <ProfileSummary />
      <MessagePrivacy />
      <BlockedAccounts />
      <View style={{ gap: space[3] }}>
        <Title>{t('st.notifications.title')}</Title>
        <PushOnThisPhone />
        <QuietHours />
      </View>
      <AppLanguage />
      <Translation />
      <AppearanceCard />
      <SettingsGroup>
        <SettingsLinkRow
          icon="apps-outline"
          title={t('yapApp.settings.more')}
          desc={t('yapApp.settings.moreDesc')}
          external
          onPress={() => void openInYapilapi('/settings')}
        />
        <SettingsLinkRow icon="server-outline" title={t('settings.data.title')} desc={t('st.yourData.desc')} onPress={() => router.push('/your-data')} />
      </SettingsGroup>
      <LegalLinks />
      <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
        <Icon name="chatbubbles" size={22} color={c.yapi} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.ink, fontSize: 15, fontWeight: '700' }}>{Platform.OS === 'ios' ? t('yapApp.about.ios') : t('yapApp.about.android')}</Text>
          <Text style={{ color: c.inkMuted, fontSize: 13 }}>
            {t('st.about.version', { version: APP_VERSION })} · {t('yapApp.tagline')}
          </Text>
        </View>
      </Card>
      <Button label={t('auth.logout')} icon="log-out-outline" variant="secondary" onPress={confirmLogout} />
    </ScrollView>
  );
}
