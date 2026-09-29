import { useState } from 'react';
import { Modal, Text } from 'react-native';
import { ApiError } from '../../../packages/api-client/src/index';
import { goHome, useConfirmLogout } from './account-menu';
import { client } from './api';
import { AuthPage, isoDay } from './auth-ui';
import { DateField } from './date-time';
import { useT } from './i18n';
import { useSession } from './session';
import { Button, Notice, Title, useColors } from './ui';

/**
 * Accounts made before a date of birth was required give it once, on this screen, the next time
 * the app opens signed in. It covers everything until it is answered. 13 to 17: the protections
 * for minors apply from now on. Under 13: the API closes the account and signs it out everywhere,
 * and this screen says so before going back to the welcome screen.
 */
export function BirthDateGate() {
  const { me, refresh, signOut } = useSession();
  const c = useColors();
  const { t } = useT();
  const [birth, setBirth] = useState<Date | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  const confirmLogout = useConfirmLogout();
  const visible = !!me?.needsBirthDate || closed;
  if (!visible) return null;

  const today = new Date();
  async function save() {
    if (busy) return;
    if (!birth) return setProblem(t('auth.birthDate.required'));
    setBusy(true);
    setProblem(null);
    try {
      await (await client()).auth.setBirthDate(isoDay(birth));
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'under_minimum_age') setClosed(true);
      // Already saved (the answer to an earlier try was lost): check again, and the screen goes.
      else if (e instanceof ApiError && e.status === 409) await refresh();
      else setProblem(e instanceof ApiError && e.code !== 'network' ? e.message : t('error.network'));
    } finally {
      setBusy(false);
    }
  }

  return (
    // Android's back button can't skip it.
    <Modal visible animationType="fade" onRequestClose={() => {}}>
      <AuthPage>
        {closed ? (
          <>
            <Title>{t('birthDate.closedTitle')}</Title>
            <Text style={{ color: c.ink, fontSize: 16, lineHeight: 22 }}>{t('birthDate.closedBody')}</Text>
            <Button
              label={t('birthDate.home')}
              onPress={async () => {
                setClosed(false);
                // Another account on this phone takes over: close what the closed account had open.
                if ((await signOut()) === 'switched') goHome();
              }}
            />
          </>
        ) : (
          <>
            <Title>{t('birthDate.title')}</Title>
            <Text style={{ color: c.ink, fontSize: 16, lineHeight: 22 }}>{t('birthDate.body')}</Text>
            {problem ? <Notice tone="danger">{problem}</Notice> : null}
            <DateField
              mode="date"
              label={t('auth.birthDate')}
              sheetTitle={t('auth.birthDate')}
              value={birth}
              onChange={setBirth}
              min={new Date(1900, 0, 1)}
              max={today}
              openAt={new Date(today.getFullYear() - 18, today.getMonth(), today.getDate())}
              note={t('m.auth.birthDate.hint')}
            />
            <Button label={busy ? t('m.common.saving') : t('birthDate.save')} disabled={busy} onPress={() => void save()} />
            {/* A way out that isn't giving a date: log out (or over to another account on this phone). */}
            <Button label={t('auth.logout')} variant="ghost" disabled={busy} onPress={confirmLogout} />
          </>
        )}
      </AuthPage>
    </Modal>
  );
}
