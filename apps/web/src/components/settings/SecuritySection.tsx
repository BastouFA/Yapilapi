'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { MfaSetup, SessionInfo } from '@yapilapi/api-client';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  FormField,
  Input,
  PasswordInput,
  Spinner,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { usePreferences } from '@/lib/preferences';
import { describeError } from '@/lib/errors';
import { ConfirmDialog, ErrorView, useFlash } from '@/components/common';
import { FormError } from '@/components/forms';
import { QrCode } from './QrCode';
import { SettingsCard } from './shared';

export function SecuritySection() {
  return (
    <div className="stack">
      <EmailCard />
      <PasswordCard />
      <MfaCard />
      <SessionsCard />
    </div>
  );
}

function EmailCard() {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const { user } = useSession();
  const [busy, setBusy] = useState(false);
  const resend = async () => {
    setBusy(true);
    try {
      await api.auth.resendVerification();
      toast.show({ tone: 'success', title: t('verify.resent') });
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
    <SettingsCard id="sc-email" title={t('security.emailTitle')}>
      <p>
        <span dir="ltr">{user.email}</span>{' '}
        {user.emailVerified ? (
          <Badge tone="success">{t('security.verified')}</Badge>
        ) : (
          <Badge tone="warning">{t('security.unverified')}</Badge>
        )}
      </p>
      {!user.emailVerified ? (
        <div>
          <Button
            variant="secondary"
            onClick={() => void resend()}
            loading={busy}
            loadingLabel={t('common.working')}
          >
            {t('verify.resend')}
          </Button>
        </div>
      ) : null}
    </SettingsCard>
  );
}

function PasswordCard() {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const fe: Record<string, string> = {};
    if (!current) fe['current'] = t('security.currentRequired');
    if (next.length < 10) fe['next'] = t('password.tooShort');
    else if (next !== confirm) fe['confirm'] = t('password.mismatch');
    setErrs(fe);
    setError(null);
    if (Object.keys(fe).length) return;
    setBusy(true);
    try {
      await api.auth.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      toast.show({ tone: 'success', title: t('security.passwordChanged') });
    } catch (err) {
      const d = describeError(err, t);
      setError(d.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard
      id="sc-pw"
      title={t('security.passwordTitle')}
      description={t('security.passwordHelp')}
    >
      <form onSubmit={(e) => void submit(e)} noValidate className="stack">
        <FormField label={t('security.currentPassword')} error={errs['current']}>
          <PasswordInput
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            showLabel={t('field.showPassword')}
            hideLabel={t('field.hidePassword')}
            data-testid="pw-current"
          />
        </FormField>
        <FormField
          label={t('field.newPassword')}
          description={t('password.rules')}
          error={errs['next']}
        >
          <PasswordInput
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            showLabel={t('field.showPassword')}
            hideLabel={t('field.hidePassword')}
            data-testid="pw-new"
          />
        </FormField>
        <FormField label={t('field.confirmPassword')} error={errs['confirm']}>
          <PasswordInput
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            showLabel={t('field.showPassword')}
            hideLabel={t('field.hidePassword')}
          />
        </FormField>
        <FormError>{error}</FormError>
        <div>
          <Button
            type="submit"
            loading={busy}
            loadingLabel={t('common.saving')}
            data-testid="pw-save"
          >
            {t('security.changePassword')}
          </Button>
        </div>
      </form>
    </SettingsCard>
  );
}

// ------------------------------------------------------------------ two-step verification
function MfaCard() {
  const api = useApi();
  const { t } = useI18n();
  const { user, refresh } = useSession();
  const toast = useToast();
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [starting, setStarting] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);

  const start = async () => {
    setStarting(true);
    try {
      setSetup(await api.auth.mfaSetup());
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setStarting(false);
    }
  };

  return (
    <SettingsCard id="sc-mfa" title={t('security.mfaTitle')} description={t('security.mfaHelp')}>
      <p>
        {user.mfaEnabled ? (
          <Badge tone="success">{t('security.mfaOn')}</Badge>
        ) : (
          <Badge tone="neutral">{t('security.mfaOff')}</Badge>
        )}
      </p>
      {user.mfaEnabled ? (
        <div>
          <Button variant="danger" onClick={() => setDisabling(true)} data-testid="mfa-disable">
            {t('security.mfaDisable')}
          </Button>
        </div>
      ) : (
        <div>
          <Button
            variant="secondary"
            onClick={() => void start()}
            loading={starting}
            loadingLabel={t('common.working')}
            data-testid="mfa-start"
          >
            {t('security.mfaStart')}
          </Button>
        </div>
      )}
      {setup ? (
        <MfaSetupDialog
          setup={setup}
          onClose={() => setSetup(null)}
          onEnabled={(rc) => {
            setSetup(null);
            setCodes(rc);
            void refresh();
          }}
        />
      ) : null}
      {codes ? <RecoveryCodesDialog codes={codes} onClose={() => setCodes(null)} /> : null}
      <MfaDisableDialog
        open={disabling}
        onClose={() => setDisabling(false)}
        onDisabled={() => {
          setDisabling(false);
          void refresh();
          toast.show({ tone: 'success', title: t('security.mfaDisabled') });
        }}
      />
    </SettingsCard>
  );
}

function MfaSetupDialog({
  setup,
  onClose,
  onEnabled,
}: {
  setup: MfaSetup;
  onClose: () => void;
  onEnabled: (codes: string[]) => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      setError(t('security.codeInvalid'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.auth.mfaEnable(code.trim());
      onEnabled(r.recoveryCodes);
    } catch (err) {
      setError(describeError(err, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('security.mfaSetupTitle')}
      closeLabel={t('common.close')}
      dismissible={!busy}
    >
      <form onSubmit={(e) => void submit(e)} noValidate className="stack">
        <ol className="steps-list">
          <li>{t('security.mfaStep1')}</li>
          <li>{t('security.mfaStep2')}</li>
        </ol>
        <div className="qr-wrap">
          <QrCode value={setup.otpauthUri} label={t('security.qrLabel')} />
        </div>
        <details className="disclosure">
          <summary>{t('security.cantScan')}</summary>
          <p>{t('security.cantScanHelp')}</p>
          <code className="secret" dir="ltr" data-testid="mfa-secret">
            {setup.secret}
          </code>
        </details>
        <FormField
          label={t('login.code')}
          description={t('login.codeHelp')}
          error={error ?? undefined}
        >
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            dir="ltr"
            data-testid="mfa-code"
          />
        </FormField>
        <div className="button-row">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            loading={busy}
            loadingLabel={t('common.working')}
            data-testid="mfa-enable"
          >
            {t('security.mfaEnable')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Recovery codes are shown once. The dialog cannot be closed until the person confirms they saved them. */
function RecoveryCodesDialog({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const { t } = useI18n();
  const [saved, setSaved] = useState(false);
  const [copied, flash] = useFlash();
  const text = codes.join('\n');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      flash();
    } catch {
      /* the codes stay visible to copy by hand */
    }
  };
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([`${t('app.name')} ${t('security.recoveryTitle')}\n\n${text}\n`], {
        type: 'text/plain',
      }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'yapilapi-recovery-codes.txt';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Dialog
      open
      onClose={() => undefined}
      dismissible={false}
      title={t('security.recoveryTitle')}
      closeLabel={t('common.close')}
      description={t('security.recoveryHelp')}
      footer={
        <Button onClick={onClose} disabled={!saved} data-testid="recovery-done">
          {t('common.done')}
        </Button>
      }
    >
      <ul className="recovery-codes" dir="ltr" data-testid="recovery-codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ul>
      <div className="button-row">
        <Button variant="secondary" onClick={() => void copy()}>
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
        <Button variant="secondary" onClick={download}>
          {t('security.download')}
        </Button>
      </div>
      <p role="status" className="yl-sr-only">
        {copied ? t('common.copied') : ''}
      </p>
      <Checkbox
        label={t('security.recoverySaved')}
        checked={saved}
        onChange={(e) => setSaved(e.target.checked)}
        data-testid="recovery-saved"
      />
    </Dialog>
  );
}

function MfaDisableDialog({
  open,
  onClose,
  onDisabled,
}: {
  open: boolean;
  onClose: () => void;
  onDisabled: () => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || !code.trim()) {
      setError(t('security.needBoth'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.auth.mfaDisable(password, code.trim());
      setPassword('');
      setCode('');
      onDisabled();
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
      title={t('security.mfaDisableTitle')}
      description={t('security.mfaDisableHelp')}
      closeLabel={t('common.close')}
      dismissible={!busy}
    >
      <form onSubmit={(e) => void submit(e)} noValidate className="stack">
        <FormField label={t('field.password')}>
          <PasswordInput
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            showLabel={t('field.showPassword')}
            hideLabel={t('field.hidePassword')}
          />
        </FormField>
        <FormField label={t('login.code')}>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            dir="ltr"
          />
        </FormField>
        <FormError>{error}</FormError>
        <div className="button-row">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="danger" loading={busy} loadingLabel={t('common.working')}>
            {t('security.mfaDisable')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ sessions
function SessionsCard() {
  const api = useApi();
  const { t, fmt } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const { saved } = usePreferences();
  const sessions = useAsync((signal) => api.auth.sessions({ signal }), [api]);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [busyAll, setBusyAll] = useState(false);

  const revoke = async (s: SessionInfo) => {
    setRevoking(s.id);
    try {
      await api.auth.revokeSession(s.id);
      sessions.setData((d) => (d ? { items: d.items.filter((x) => x.id !== s.id) } : d));
      toast.show({ tone: 'success', title: t('security.sessionEnded') });
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setRevoking(null);
    }
  };
  const logoutAll = async () => {
    setBusyAll(true);
    try {
      await api.auth.logoutAll();
      router.replace('/login');
      router.refresh();
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
      setBusyAll(false);
    }
  };

  return (
    <SettingsCard
      id="sc-sessions"
      title={t('security.sessionsTitle')}
      description={t('security.sessionsHelp')}
    >
      {sessions.loading && !sessions.data ? <Spinner label={t('common.loading')} /> : null}
      {sessions.error && !sessions.data ? (
        <ErrorView error={sessions.error} onRetry={sessions.reload} />
      ) : null}
      {sessions.data ? (
        <ul className="session-list" aria-label={t('security.sessionsTitle')}>
          {sessions.data.items.map((s) => (
            <li key={s.id} className="session-row">
              <div className="session-row__text">
                <strong>{s.deviceLabel || s.userAgent || t('security.unknownDevice')}</strong>{' '}
                {s.current ? <Badge tone="primary">{t('security.thisDevice')}</Badge> : null}
                <span className="muted">
                  {t('security.lastActive', { when: fmt.dateTime(s.lastSeenAt, saved?.timezone) })}
                  {s.ipHint ? ` · ${s.ipHint}` : ''}
                </span>
              </div>
              {!s.current ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void revoke(s)}
                  loading={revoking === s.id}
                  loadingLabel={t('common.working')}
                  aria-label={t('security.endSession', {
                    device: s.deviceLabel || s.userAgent || t('security.unknownDevice'),
                  })}
                >
                  {t('security.endSessionShort')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div>
        <Button variant="danger" onClick={() => setConfirmAll(true)} data-testid="logout-all">
          {t('security.logoutAll')}
        </Button>
      </div>
      <ConfirmDialog
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        title={t('security.logoutAllTitle')}
        description={t('security.logoutAllBody')}
        confirmLabel={t('security.logoutAll')}
        danger
        busy={busyAll}
        onConfirm={() => void logoutAll()}
      />
    </SettingsCard>
  );
}
