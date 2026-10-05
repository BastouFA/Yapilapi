'use client';

import { useEffect, useState } from 'react';
import { Button, Card, Dialog, List, ListItem, TextField } from '@yapilapi/design-system';
import { appealStatusText, formatRelativeTime, moderationCaseText, type InteractionSettings } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import { Anchor, ChoiceGroup, PeopleCard } from './Shell';

/** Sensitive photos and videos: covered until you choose to see them, or not shown at all. */
export function SensitiveCard() {
  const { t, toast } = useSession();
  const [settings, setSettings] = useState<InteractionSettings | null>(null);
  useEffect(() => {
    api.me.interactions().then(
      (r) => setSettings(r.settings),
      (e) => toast(errorMessage(e)),
    );
  }, [toast]);
  if (!settings) return null;
  return (
    <Anchor id="sensitive">
      <Card title={t('st.sensitive.title')} subtitle={t('st.sensitive.desc')}>
        <ChoiceGroup
          legend={t('st.sensitive.title')}
          value={settings.sensitiveMedia}
          disabled={settings.sensitiveLocked}
          hint={settings.sensitiveLocked ? t('st.sensitive.locked') : undefined}
          onChange={async (v) => {
            const before = settings;
            setSettings({ ...settings, sensitiveMedia: v });
            try {
              setSettings((await api.me.setInteractions({ sensitiveMedia: v })).settings);
            } catch (e) {
              setSettings(before);
              toast(errorMessage(e));
            }
          }}
          options={[
            { id: 'standard', label: t('st.sensitive.standard'), hint: t('st.sensitive.standardHint') },
            { id: 'less', label: t('st.sensitive.less'), hint: t('st.sensitive.lessHint') },
          ]}
        />
      </Card>
    </Anchor>
  );
}

const loadRestricted = () => api.me.restricted();

/** People you restricted: their comments on your posts are seen only by them and you. */
export function RestrictedCard() {
  return (
    <PeopleCard
      id="restricted"
      title="st.restricted.title"
      subtitle="st.restricted.desc"
      empty="st.restricted.none"
      undoLabel="st.restricted.undo"
      load={loadRestricted}
      undo={(id) => api.users.unrestrict(id)}
    />
  );
}

/** Decisions our team made about your content, and appeals. */
export function ModerationCard() {
  const { toast, locale, t } = useSession();
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.me.moderation>>['items'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [appealFor, setAppealFor] = useState<string | null>(null);
  const [statement, setStatement] = useState('');
  const [sending, setSending] = useState(false);
  useEffect(() => {
    setError(null);
    api.me.moderation().then(
      (r) => setItems(r.items),
      (e) => setError(errorMessage(e)),
    );
  }, [attempt]);
  return (
    <Anchor id="moderation">
      <Card title={t('settings.moderation.title')}>
        {error && !items ? (
          <div className="row">
            <span role="alert">{error}</span>
            <Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
              {t('m.common.retry')}
            </Button>
          </div>
        ) : !items ? (
          <p className="muted" style={{ margin: 0 }}>
            {t('common.loading')}
          </p>
        ) : items.length ? (
          <List>
            {items.map((c) => (
              <ListItem
                key={c.id}
                primary={moderationCaseText(c, t)}
                secondary={[
                  c.decided_at ? formatRelativeTime(c.decided_at, locale) : null,
                  c.appeal_status ? appealStatusText(c.appeal_status, t) : c.status === 'decided' ? t('settings.appeal.can') : t('settings.appeal.final'),
                ]
                  .filter(Boolean)
                  .join(' · ')}
                end={
                  c.status === 'decided' && !c.appeal_status ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setStatement('');
                        setAppealFor(c.id);
                      }}
                    >
                      {t('settings.appeal')}
                    </Button>
                  ) : null
                }
              />
            ))}
          </List>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            {t('settings.moderation.none')}
          </p>
        )}
      </Card>
      <Dialog
        open={!!appealFor}
        onClose={() => setAppealFor(null)}
        title={t('settings.appeal.title')}
        footer={
          <Button
            disabled={!statement.trim()}
            loading={sending}
            onClick={async () => {
              setSending(true);
              try {
                await api.raw.post('/v1/appeals', { caseId: appealFor, statement: statement.trim() });
                toast(t('settings.appeal.sent'));
                setAppealFor(null);
                setStatement('');
                setAttempt((n) => n + 1);
              } catch (e) {
                toast(errorMessage(e));
              } finally {
                setSending(false);
              }
            }}
          >
            {t('settings.appeal.send')}
          </Button>
        }
      >
        <TextField label={t('settings.appeal.why')} multiline value={statement} onChange={(e) => setStatement(e.currentTarget.value)} maxLength={2000} />
      </Dialog>
    </Anchor>
  );
}
