'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, FormField, PasswordInput, useToast } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { usePreferences } from '@/lib/preferences';
import { describeError } from '@/lib/errors';
import { FormError } from '@/components/forms';
import { SettingsCard } from './shared';

const GRACE_DAYS = 14;

export function AccountSection() {
  const { t, fmt } = useI18n();
  const api = useApi();
  const toast = useToast();
  const { user, refresh } = useSession();
  const { saved } = usePreferences();
  const [dialog, setDialog] = useState<'deactivate' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);

  const cancel = async () => {
    setBusy(true);
    try {
      await api.account.cancelDeletion();
      await refresh();
      toast.show({ tone: 'success', title: t('account.deletionCancelled') });
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <SettingsCard id="ac-info" title={t('accountSettings.infoTitle')}>
        <dl className="facts">
          <div>
            <dt>{t('field.email')}</dt>
            <dd dir="ltr">{user.email}</dd>
          </div>
          <div>
            <dt>{t('field.username')}</dt>
            <dd dir="ltr">@{user.profile.username}</dd>
          </div>
        </dl>
      </SettingsCard>

      <SettingsCard
        id="ac-deactivate"
        title={t('accountSettings.deactivateTitle')}
        description={t('accountSettings.deactivateHelp')}
      >
        <div>
          <Button
            variant="secondary"
            onClick={() => setDialog('deactivate')}
            data-testid="deactivate-open"
          >
            {t('accountSettings.deactivate')}
          </Button>
        </div>
      </SettingsCard>

      <SettingsCard
        id="ac-delete"
        title={t('accountSettings.deleteTitle')}
        description={t('accountSettings.deleteHelp', { days: GRACE_DAYS })}
      >
        {user.deletionScheduledFor ? (
          <>
            <p className="yl-notice yl-notice--warning" role="status">
              {t('account.deletionBanner', {
                date: fmt.dateTime(user.deletionScheduledFor, saved?.timezone),
              })}
            </p>
            <div>
              <Button
                onClick={() => void cancel()}
                loading={busy}
                loadingLabel={t('common.working')}
              >
                {t('account.cancelDeletion')}
              </Button>
            </div>
          </>
        ) : (
          <div>
            <Button variant="danger" onClick={() => setDialog('delete')} data-testid="delete-open">
              {t('accountSettings.delete')}
            </Button>
          </div>
        )}
      </SettingsCard>

      <PasswordDialog
        open={dialog === 'deactivate'}
        onClose={() => setDialog(null)}
        title={t('accountSettings.deactivateDialog')}
        body={t('accountSettings.deactivateBody')}
        confirmLabel={t('accountSettings.deactivate')}
        run={(pw) => api.account.deactivate(pw)}
        onDone={(router) => {
          router.replace('/login');
          router.refresh();
        }}
      />
      <PasswordDialog
        open={dialog === 'delete'}
        onClose={() => setDialog(null)}
        title={t('accountSettings.deleteDialog')}
        body={t('accountSettings.deleteBody', { days: GRACE_DAYS })}
        confirmLabel={t('accountSettings.delete')}
        run={(pw) => api.account.requestDeletion(pw)}
        onDone={() => {
          setDialog(null);
          void refresh();
        }}
      />
    </div>
  );
}

function PasswordDialog({
  open,
  onClose,
  title,
  body,
  confirmLabel,
  run,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  body: string;
  confirmLabel: string;
  run: (password: string) => Promise<unknown>;
  onDone: (router: ReturnType<typeof useRouter>) => void;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError(t('security.currentRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await run(password);
      setPassword('');
      onDone(router);
    } catch (err) {
      setError(describeError(err, t).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={body}
      closeLabel={t('common.close')}
      dismissible={!busy}
    >
      <form onSubmit={(e) => void submit(e)} noValidate className="stack">
        <FormField label={t('accountSettings.confirmWithPassword')}>
          <PasswordInput
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            showLabel={t('field.showPassword')}
            hideLabel={t('field.hidePassword')}
            data-testid="account-password"
          />
        </FormField>
        <FormError>{error}</FormError>
        <div className="button-row">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            variant="danger"
            loading={busy}
            loadingLabel={t('common.working')}
            data-testid="account-confirm"
          >
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
