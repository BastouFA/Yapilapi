'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert, Button, Card, TextField } from '@yapilapi/design-system';
import { LEGAL_DOCS } from '@yapilapi/shared';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { useSession } from '@/app/providers';
import { Anchor } from './Shell';

export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '0.1.0';

/** Report a problem: what happened, with the page and version so it can be found. */
export function ProblemCard() {
  const { t } = useSession();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Anchor id="problem">
      <Card title={t('st.problem.title')} subtitle={t('st.problem.desc')}>
        {sent ? (
          <div className="stack-sm">
            <Alert tone="success">{t('st.problem.sent')}</Alert>
            <div>
              <Button size="sm" variant="ghost" onClick={() => (setSent(false), setBody(''))}>
                {t('st.problem.another')}
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="stack-sm"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setErr(null);
              try {
                await api.me.reportProblem({
                  body,
                  platform: 'web',
                  appVersion: APP_VERSION,
                  page: document.referrer ? new URL(document.referrer).pathname : undefined,
                });
                setSent(true);
              } catch (e2) {
                setErr(fieldErrors(e2).body ? t('st.problem.short') : errorMessage(e2));
              } finally {
                setBusy(false);
              }
            }}
          >
            {err ? <Alert tone="danger">{err}</Alert> : null}
            <TextField
              label={t('st.problem.label')}
              multiline
              rows={4}
              value={body}
              onChange={(e) => setBody(e.currentTarget.value)}
              maxLength={2000}
              required
            />
            <div>
              <Button type="submit" loading={busy} disabled={body.trim().length < 5}>
                {t('st.problem.send')}
              </Button>
            </div>
          </form>
        )}
      </Card>
    </Anchor>
  );
}

/** Every policy, with its summary. */
export function LegalListCard() {
  const { t } = useSession();
  return (
    <Anchor id="legal">
      <Card title={t('legal.title')} subtitle={t('legal.index.body')}>
        <ul className="legal-index">
          {LEGAL_DOCS.map((d) => (
            <li key={d.slug}>
              <Link href={`/legal/${d.slug}`}>{t(d.title)}</Link>
              <span className="muted">{t(d.summary)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </Anchor>
  );
}

export function AboutCard() {
  const { t } = useSession();
  return (
    <Anchor id="about">
      <Card title={t('st.about.title')}>
        <div className="settings-about">
          <img src="/mark.svg" alt="" width={40} height={40} />
          <div>
            <strong>{t('st.about.web')}</strong>
            <p className="muted" style={{ margin: 0 }}>
              {t('st.about.version', { version: APP_VERSION })} · {t('app.tagline')}
            </p>
          </div>
        </div>
      </Card>
    </Anchor>
  );
}
