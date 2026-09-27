import { Stack, useLocalSearchParams } from 'expo-router';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { useT } from '../../lib/i18n';
import { VerificationCard } from '../../lib/safety';
import { useSession } from '../../lib/session';
import { SECTIONS, type SectionId } from '../../lib/settings-catalog';
import {
  About,
  AccountDetails,
  Activity,
  AppearanceCard,
  AppLanguage,
  ChangePassword,
  ConnectedApps,
  LegalLinks,
  LinkRow,
  LogoutEverywhere,
  MutedAccounts,
  PasskeysOnWeb,
  PrivateAccount,
  ProfileSummary,
  PushOnThisPhone,
  QuietHours,
  ReportProblem,
  RestrictedAccounts,
  SensitiveContent,
  SettingsGroup,
  SignInAlerts,
  TwoStep,
  WhoCanReach,
} from '../../lib/settings-extra';
import { BlockedAccounts, DataUseSettings, FeedSettings, NotificationSettings, SessionsCard } from '../../lib/settings-more';
import { Advertising, DataSaver, Family, HiddenWords, Sharing, Tagging, Translation } from '../../lib/settings-sections';
import { space } from '../../lib/theme';
import { Loading, Notice, useColors } from '../../lib/ui';

/** Each section's settings, in the order they appear. */
function Content({ section }: { section: SectionId }): ReactNode {
  const { t } = useT();
  switch (section) {
    case 'account':
      return (
        <>
          <ProfileSummary />
          <VerificationCard />
          <AccountDetails />
          <SettingsGroup>
            <LinkRow
              icon="key-outline"
              title={t('st.password.title')}
              desc={t('st.password.desc')}
              href={{ pathname: '/settings/[section]', params: { section: 'security' } }}
            />
          </SettingsGroup>
        </>
      );
    case 'notifications':
      return (
        <>
          <PushOnThisPhone />
          <QuietHours />
          <NotificationSettings />
        </>
      );
    case 'feed':
      return <FeedSettings />;
    case 'privacy':
      return (
        <>
          <PrivateAccount />
          <WhoCanReach />
          <Tagging />
          <SettingsGroup>
            <LinkRow icon="star-outline" title={t('m.closeFriends.title')} desc={t('m.closeFriends.manage')} href="/close-friends" />
            <LinkRow icon="ellipse-outline" title={t('m.circles.title')} desc={t('m.circles.manage')} href="/circles" />
            <LinkRow icon="archive-outline" title={t('m.archive.title')} desc={t('m.archive.manage')} href="/archive" />
          </SettingsGroup>
          <BlockedAccounts />
          <MutedAccounts />
          <HiddenWords />
          <Sharing />
          <DataUseSettings />
          <Advertising />
        </>
      );
    case 'security':
      return (
        <>
          <ChangePassword />
          <TwoStep />
          <PasskeysOnWeb />
          <SessionsCard />
          <LogoutEverywhere />
          <SignInAlerts />
          <Activity />
          <ConnectedApps />
        </>
      );
    case 'safety':
      return (
        <>
          <Family />
          <RestrictedAccounts />
          <SensitiveContent />
        </>
      );
    case 'data-saver':
      return <DataSaver />;
    case 'language':
      return (
        <>
          <AppLanguage />
          <Translation />
        </>
      );
    case 'appearance':
      return <AppearanceCard />;
    case 'help':
      return (
        <>
          <ReportProblem />
          <LegalLinks />
          <About />
        </>
      );
    default:
      return null;
  }
}

/** One settings section (/settings/<section>): its title, a line about it, then its settings. */
export default function SettingsSection() {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const { section } = useLocalSearchParams<{ section: string }>();
  const s = SECTIONS[section as SectionId];
  if (me === undefined) return <Loading />;
  if (!me || !s)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice>{t('m.common.signedOut')}</Notice>
      </View>
    );
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.ground }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={100}>
      <Stack.Screen options={{ title: t(s.title) }} />
      <ScrollView
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <Text style={{ color: c.inkMuted, fontSize: 15, lineHeight: 21 }}>{t(s.desc)}</Text>
        <Content section={s.id} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
