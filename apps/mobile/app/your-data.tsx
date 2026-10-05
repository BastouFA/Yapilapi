import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { goHome } from '../lib/account-menu';
import { client, errorMessage } from '../lib/api';
import { PasswordField } from '../lib/auth-ui';
import { useT } from '../lib/i18n';
import { openLegal } from '../lib/legal';
import { useSession } from '../lib/session';
import { space } from '../lib/theme';
import { Button, Card, Loading, Notice, Title, useColors } from '../lib/ui';

/**
 * Your data: download a copy (GET /v1/me/export, saved as a JSON file and handed to the share
 * sheet) and delete your account (DELETE /v1/me with your password). Deleting happens right away;
 * the screen says what goes, what is kept and for how long, the same as the web and the privacy
 * policy.
 */
export default function YourData() {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  if (me === undefined) return <Loading />;
  if (!me)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice>{t('m.common.signedOut')}</Notice>
      </View>
    );
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.ground }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }} keyboardShouldPersistTaps="handled">
        <Download />
        <Delete />
        <Button label={t('legal.privacy')} icon="open-outline" variant="ghost" onPress={() => void openLegal('privacy')} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Download() {
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await (await client()).me.exportData();
      const file = new File(Paths.cache, `yapilapi-data-${new Date().toISOString().slice(0, 10)}.json`);
      if (file.exists) file.delete();
      file.create();
      file.write(JSON.stringify(data, null, 2));
      if (!(await Sharing.isAvailableAsync())) throw new Error(t('m.account.download.failed'));
      await Sharing.shareAsync(file.uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: t('privacy.export') });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={t('account.download.hint')}>{t('privacy.export')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button
        label={busy ? t('m.account.download.preparing') : t('privacy.export')}
        icon="download-outline"
        variant="secondary"
        disabled={busy}
        onPress={() => void download()}
      />
    </Card>
  );
}

function Delete() {
  const c = useColors();
  const { t } = useT();
  const { signOut } = useSession();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await (await client()).me.deleteAccount(password);
      const next = await signOut();
      Alert.alert(t('account.deleted'));
      // Another account on this phone takes over: close these screens. Nobody left: the root layout opens the welcome screen.
      if (next === 'switched') goHome();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const confirm = () => {
    if (busy) return;
    if (!password) return setError(t('account.delete.passwordNeeded'));
    Alert.alert(t('settings.deleteAccount.title'), t('settings.deleteAccount.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('settings.deleteAccount.confirm'), style: 'destructive', onPress: () => void remove() },
    ]);
  };

  const section = (title: string, body: string) => (
    <View style={{ gap: 2 }}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700' }}>
        {title}
      </Text>
      <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{body}</Text>
    </View>
  );

  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={t('account.delete.hint')}>{t('privacy.delete')}</Title>
      {section(t('account.delete.now'), t('account.delete.now.body'))}
      {section(t('account.delete.kept'), t('account.delete.kept.body'))}
      {section(t('account.delete.before'), t('account.delete.before.body'))}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <PasswordField
        t={t}
        label={t('settings.deleteAccount.password')}
        value={password}
        onChangeText={(v) => {
          setPassword(v);
          setError(null);
        }}
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="done"
        onSubmitEditing={confirm}
      />
      <Button label={t('settings.deleteAccount.confirm')} icon="trash-outline" variant="danger" disabled={busy || !password} onPress={confirm} />
    </Card>
  );
}
