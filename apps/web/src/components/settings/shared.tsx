'use client';

import { useCallback, type ReactNode } from 'react';
import type { PreferencesUpdate } from '@yapilapi/api-client';
import { useToast } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { usePreferences } from '@/lib/preferences';
import { describeError } from '@/lib/errors';

export function SettingsCard({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-h`} className="settings-card">
      <h3 id={`${id}-h`} className="settings-card__title">
        {title}
      </h3>
      {description ? <p className="settings-card__desc">{description}</p> : null}
      <div className="settings-card__body stack">{children}</div>
    </section>
  );
}

/** Save one or more preferences to the API and tell the person (toast) whether it worked. */
export function useSavePrefs() {
  const { update } = usePreferences();
  const toast = useToast();
  const { t } = useI18n();
  return useCallback(
    async (patch: PreferencesUpdate): Promise<boolean> => {
      try {
        await update(patch);
        toast.show({ tone: 'success', title: t('common.saved') });
        return true;
      } catch (e) {
        toast.show({
          tone: 'danger',
          title: t('error.actionFailed'),
          description: describeError(e, t).message,
        });
        return false;
      }
    },
    [update, toast, t],
  );
}
