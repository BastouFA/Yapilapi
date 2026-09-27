'use client';

import { useEffect, useState } from 'react';
import { Alert, Button, Card, Dialog } from '@yapilapi/design-system';
import type { MessageKey } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { PasswordField } from '@/components/PasswordField';
import { useSession } from '@/app/providers';
import { Anchor } from './Shell';

/** Rows of "What we hold about you", named by the API's column names. */
const HELD: Record<string, MessageKey> = {
  posts: 'settings.held.posts',
  comments: 'settings.held.comments',
  messages: 'settings.held.messages',
  media: 'settings.held.media',
  ai_memories: 'settings.held.ai_memories',
  active_sessions: 'settings.held.active_sessions',
};

export function HeldCard() {
  const { t, locale } = useSession();
  const [summary, setSummary] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    api.me.privacy().then(
      (r) => setSummary(r.dataSummary as Record<string, number>),
      () => {},
    );
  }, []);
  if (!summary) return null;
  const n = new Intl.NumberFormat(locale);
  return (
    <Anchor id="held">
      <Card title={t('settings.held.title')}>
        <div className="stats">
          {Object.entries(summary).map(([k, v]) => (
            <div key={k} className="yp-stat">
              <span className="yp-stat__label">{HELD[k] ? t(HELD[k]) : k.replace(/_/g, ' ')}</span>
              <span className="yp-stat__value">{n.format(Number(v))}</span>
            </div>
          ))}
        </div>
      </Card>
    </Anchor>
  );
}

/** A copy of your data as a JSON file. */
export function DownloadCard() {
  const { t, toast } = useSession();
  const [busy, setBusy] = useState(false);
  return (
    <Anchor id="download">
      <Card title={t('privacy.export')} subtitle={t('account.download.hint')}>
        <Button
          variant="secondary"
          icon="download"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const blob = new Blob([JSON.stringify(await api.me.exportData(), null, 2)], { type: 'application/json' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = 'yapilapi-data.json';
              a.click();
              URL.revokeObjectURL(a.href);
            } catch (e) {
              toast(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('privacy.export')}
        </Button>
      </Card>
    </Anchor>
  );
}

/** What deleting an account removes right away, what is kept and for how long (the phone app shows the same). */
function DeletionDetails() {
  const { t } = useSession();
  return (
    <div className="stack-sm" style={{ fontSize: 14 }}>
      {(
        [
          ['account.delete.now', 'account.delete.now.body'],
          ['account.delete.kept', 'account.delete.kept.body'],
          ['account.delete.before', 'account.delete.before.body'],
        ] as const
      ).map(([title, body]) => (
        <div key={title}>
          <strong>{t(title)}</strong>
          <p className="muted" style={{ margin: 0 }}>
            {t(body)}
          </p>
        </div>
      ))}
    </div>
  );
}

/** Delete the account, with the password, after saying what goes and what is kept. */
export function DeleteAccountCard() {
  const { t } = useSession();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Anchor id="delete">
      <Card title={t('privacy.delete')} subtitle={t('account.delete.hint')}>
        <Button variant="danger" icon="trash" onClick={() => setOpen(true)}>
          {t('privacy.delete')}
        </Button>
      </Card>
      <Dialog
        open={open}
        onClose={() => !busy && setOpen(false)}
        title={t('settings.deleteAccount.title')}
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={!password}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  await api.me.deleteAccount(password);
                  location.replace('/');
                } catch (e) {
                  setErr(errorMessage(e));
                  setBusy(false);
                }
              }}
            >
              {t('settings.deleteAccount.confirm')}
            </Button>
          </>
        }
      >
        <div className="stack-sm">
          <p style={{ margin: 0 }}>{t('settings.deleteAccount.body')}</p>
          <DeletionDetails />
          {err ? <Alert tone="danger">{err}</Alert> : null}
          <PasswordField
            label={t('settings.deleteAccount.password')}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
        </div>
      </Dialog>
    </Anchor>
  );
}
