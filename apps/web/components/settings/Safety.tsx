'use client';

import { useEffect, useState } from 'react';
import { Button, Card, Dialog, List, ListItem, TextField } from '@yapilapi/design-system';
import type { InteractionSettings } from '@yapilapi/shared';
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
  const { toast, t } = useSession();
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.me.moderation>>['items']>([]);
  const [appealFor, setAppealFor] = useState<string | null>(null);
  const [statement, setStatement] = useState('');
  useEffect(() => {
    api.me.moderation().then(
      (r) => setItems(r.items),
      () => {},
    );
  }, []);
  return (
    <Anchor id="moderation">
      <Card title={t('settings.moderation.title')}>
        {items.length ? (
          <List>
            {items.map((c) => (
              <ListItem
                key={c.id}
                primary={`${c.target_type}: ${c.decision.replace('_', ' ')}`}
                secondary={
                  c.appeal_status
                    ? t('settings.appeal.status', { status: c.appeal_status })
                    : c.status === 'decided'
                      ? t('settings.appeal.can')
                      : t('settings.appeal.final')
                }
                end={
                  c.status === 'decided' && !c.appeal_status ? (
                    <Button size="sm" variant="secondary" onClick={() => setAppealFor(c.id)}>
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
            onClick={async () => {
              try {
                await api.raw.post('/v1/appeals', { caseId: appealFor, statement });
                toast(t('settings.appeal.sent'));
                setAppealFor(null);
                setItems((await api.me.moderation()).items);
              } catch (e) {
                toast(errorMessage(e));
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
