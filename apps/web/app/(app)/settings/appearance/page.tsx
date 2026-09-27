'use client';

import { Card } from '@yapilapi/design-system';
import { AppearancePicker } from '@/components/AccountMenu';
import { SettingsPage } from '@/components/settings/Shell';
import { useSession } from '../../../providers';

/** Appearance: Light, Dark or Match device, applied right away and remembered in this browser. */
export default function AppearanceSettings() {
  const { t } = useSession();
  return (
    <SettingsPage section="appearance">
      <Card title={t('st.appearance.theme')} subtitle={t('st.appearance.hint')}>
        <AppearancePicker />
      </Card>
    </SettingsPage>
  );
}
