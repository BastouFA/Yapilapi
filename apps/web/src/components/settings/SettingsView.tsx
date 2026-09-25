'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useI18n } from '@/i18n';
import { usePageTitle } from '@/lib/hooks';
import { usePreferences } from '@/lib/preferences';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, PageSpinner } from '@/components/common';
import { SETTINGS_SECTIONS, type SettingsSection } from './sections';
import { ProfileSection } from './ProfileSection';
import { PrivacySection } from './PrivacySection';
import { AttentionSection } from './AttentionSection';
import { DisplaySection } from './DisplaySection';
import { SecuritySection } from './SecuritySection';
import { ConnectionsSection } from './ConnectionsSection';
import { AccountSection } from './AccountSection';
import { PrivacyCenterSection } from './PrivacyCenterSection';

export function SettingsView({ section }: { section: SettingsSection }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const { saved, loading, error, reload } = usePreferences();
  usePageTitle(`${t(`settings.nav.${section}`)} · ${t('nav.settings')}`, t('app.name'));
  const needsPrefs = section === 'privacy' || section === 'attention' || section === 'display';

  return (
    <>
      <PageHeader title={t('nav.settings')} />
      <div className="settings">
        <nav aria-label={t('settings.navLabel')} className="settings__nav">
          <ul>
            {SETTINGS_SECTIONS.map((s) => {
              const href = `/settings/${s}`;
              const active = pathname === href;
              return (
                <li key={s}>
                  <Link
                    href={href}
                    aria-current={active ? 'page' : undefined}
                    className={active ? 'settings__link is-active' : 'settings__link'}
                    data-testid={`settings-${s}`}
                  >
                    {t(`settings.nav.${s}`)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="settings__panel">
          <h2 className="settings__heading">{t(`settings.nav.${section}`)}</h2>
          {needsPrefs && !saved ? (
            loading ? (
              <PageSpinner />
            ) : error ? (
              <ErrorView error={error} onRetry={reload} />
            ) : null
          ) : null}
          {section === 'profile' ? <ProfileSection /> : null}
          {section === 'privacy' && saved ? <PrivacySection /> : null}
          {section === 'attention' && saved ? <AttentionSection /> : null}
          {section === 'display' && saved ? <DisplaySection /> : null}
          {section === 'security' ? <SecuritySection /> : null}
          {section === 'connections' ? <ConnectionsSection /> : null}
          {section === 'account' ? <AccountSection /> : null}
          {section === 'data' ? <PrivacyCenterSection /> : null}
        </div>
      </div>
    </>
  );
}
