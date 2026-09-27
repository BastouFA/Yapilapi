'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button, Card, List, ListItem, Switch, TextField } from '@yapilapi/design-system';
import type { InteractionSettings, MessageKey, TagPermission } from '@yapilapi/shared';
import type { SharingSettings as SharingSettingsState } from '@yapilapi/api-client';
import { api, errorMessage } from '@/lib/api';
import { CloseFriendsCard } from '@/components/CloseFriends';
import { useSession } from '@/app/providers';
import { Anchor, ChoiceGroup, PeopleCard } from './Shell';

/** Private account: only approved followers see your posts. */
export function PrivateAccountCard() {
  const { me, t, toast } = useSession();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    if (me) api.users.get(me.username).then((r) => setOn(!!r.profile.isPrivate));
  }, [me]);
  if (on === null) return null;
  return (
    <Anchor id="private">
      <Card>
        <Switch
          label={t('settings.private')}
          checked={on}
          onChange={async (v) => {
            setOn(v);
            try {
              await api.me.updateProfile({ isPrivate: v });
            } catch (e) {
              setOn(!v);
              toast(errorMessage(e));
            }
          }}
        />
        <p className="muted setting-hint" style={{ margin: '6px 0 0' }}>
          {t('settings.privateHint')}
        </p>
      </Card>
    </Anchor>
  );
}

/** Who can message, comment on, mention and tag you. Friends always can. */
export function ReachCard() {
  const { t, toast } = useSession();
  const [settings, setSettings] = useState<InteractionSettings | null>(null);
  const [tags, setTags] = useState<TagPermission | null>(null);
  useEffect(() => {
    api.me.interactions().then(
      (r) => setSettings(r.settings),
      (e) => toast(errorMessage(e)),
    );
    api.me.tagging().then(
      (r) => setTags(r.allowFrom),
      () => {},
    );
  }, [toast]);
  if (!settings) return null;
  const save = async (patch: Partial<InteractionSettings>) => {
    const before = settings;
    setSettings({ ...settings, ...patch });
    try {
      setSettings((await api.me.setInteractions(patch)).settings);
    } catch (e) {
      setSettings(before);
      toast(errorMessage(e));
    }
  };
  const label = (k: MessageKey) => t(k);
  return (
    <Anchor id="reach">
      <Card title={t('st.who.title')} subtitle={t('st.who.friendsAlways')}>
        <div className="stack">
          <ChoiceGroup
            legend={t('st.who.message')}
            hint={t('st.who.messageHint')}
            value={settings.messagesFrom}
            onChange={(v) => save({ messagesFrom: v })}
            options={[
              { id: 'everyone', label: label('st.who.everyone') },
              { id: 'following', label: label('st.who.following') },
              { id: 'friends', label: label('st.who.friends') },
            ]}
          />
          <ChoiceGroup
            legend={t('st.who.comment')}
            hint={t('st.who.commentHint')}
            value={settings.commentsFrom}
            onChange={(v) => save({ commentsFrom: v })}
            options={[
              { id: 'everyone', label: label('st.who.everyone') },
              { id: 'following', label: label('st.who.following') },
              { id: 'followers', label: label('st.who.followers') },
            ]}
          />
          <ChoiceGroup
            legend={t('st.who.mention')}
            hint={t('st.who.mentionHint')}
            value={settings.mentionsFrom}
            onChange={(v) => save({ mentionsFrom: v })}
            options={[
              { id: 'everyone', label: label('st.who.everyone') },
              { id: 'following', label: label('st.who.following') },
              { id: 'nobody', label: label('st.who.nobody') },
            ]}
          />
          {tags ? (
            <ChoiceGroup
              legend={t('settings.tags.who')}
              hint={t('settings.tags.hint')}
              value={tags}
              onChange={async (v) => {
                const before = tags;
                setTags(v);
                try {
                  setTags((await api.me.setTagging(v)).allowFrom);
                } catch (e) {
                  setTags(before);
                  toast(errorMessage(e));
                }
              }}
              options={[
                { id: 'everyone', label: label('st.who.everyone') },
                { id: 'following', label: label('st.who.following') },
                { id: 'nobody', label: label('st.who.nobody') },
              ]}
            />
          ) : null}
        </div>
      </Card>
    </Anchor>
  );
}

/** Close friends, circles and your archive. */
export function AudiencesCard() {
  const { t } = useSession();
  return (
    <Anchor id="close-friends">
      <div className="stack">
        <CloseFriendsCard />
        <Card title={t('settings.circles.title')}>
          <p className="muted" style={{ marginTop: 0 }}>
            {t('settings.circles.body')}
          </p>
          <Link href="/circles" className="yp-btn yp-btn--secondary yp-btn--sm">
            {t('settings.circles.manage')}
          </Link>
        </Card>
        <Card title={t('settings.archive.title')}>
          <p className="muted" style={{ marginTop: 0 }}>
            {t('settings.archive.body')}
          </p>
          <Link href="/archive" className="yp-btn yp-btn--secondary yp-btn--sm">
            {t('settings.archive.open')}
          </Link>
        </Card>
      </div>
    </Anchor>
  );
}

const loadBlocked = () => api.raw.get<{ items: { id: string; displayName: string; username?: string; avatarUrl?: string | null }[] }>('/v1/me/blocked');
const loadMuted = () => api.me.muted();

export function BlockedCard() {
  return (
    <PeopleCard
      id="blocked"
      title="settings.blocked.title"
      empty="settings.blocked.none"
      undoLabel="profile.unblock"
      load={loadBlocked}
      undo={(id) => api.users.unblock(id)}
    />
  );
}

export function MutedCard() {
  return (
    <PeopleCard
      id="muted"
      title="st.muted.title"
      subtitle="st.muted.desc"
      empty="st.muted.none"
      undoLabel="m.profile.unmute"
      load={loadMuted}
      undo={(id) => api.users.unmute(id)}
    />
  );
}

/** Let people who have your email or phone number find you; allow downloads of your reels. */
export function SharingCard() {
  const { toast, t } = useSession();
  const [settings, setSettings] = useState<SharingSettingsState | null>(null);
  useEffect(() => {
    api.me.sharing().then(
      (r) => setSettings(r.settings),
      () => {},
    );
  }, []);
  if (!settings) return null;
  const set = async (k: 'findableByContacts' | 'allowDownload', v: boolean) => {
    const before = settings;
    setSettings({ ...settings, [k]: v });
    try {
      setSettings((await api.me.setSharing({ [k]: v })).settings);
    } catch (e) {
      setSettings(before);
      toast(errorMessage(e));
    }
  };
  return (
    <Anchor id="sharing">
      <Card title={t('sharing.title')} subtitle={settings.locked ? t('sharing.locked') : undefined}>
        <div className="stack">
          <div className="stack-sm">
            <Switch
              label={t('sharing.findable')}
              checked={settings.findableByContacts}
              disabled={settings.locked}
              onChange={(v) => set('findableByContacts', v)}
            />
            <p className="muted setting-hint">{t('sharing.findable.hint')}</p>
          </div>
          <div className="stack-sm">
            <Switch label={t('sharing.allowDownload')} checked={settings.allowDownload} disabled={settings.locked} onChange={(v) => set('allowDownload', v)} />
            <p className="muted setting-hint">{t('sharing.allowDownload.hint')}</p>
          </div>
        </div>
      </Card>
    </Anchor>
  );
}

const PURPOSES: Record<string, MessageKey> = {
  personalization: 'settings.purpose.personalization',
  ai_processing: 'settings.purpose.ai_processing',
  advertising: 'settings.purpose.advertising',
  analytics: 'settings.purpose.analytics',
};

/** Personalization, the assistant's memory, sponsored posts and usage analytics: each can be turned off. */
export function DataUseCard() {
  const { toast, t } = useSession();
  const [consents, setConsents] = useState<{ purpose: string; granted: boolean }[] | null>(null);
  const reload = () => api.me.privacy().then((r) => setConsents(r.consents));
  useEffect(() => {
    void reload();
  }, []);
  if (!consents) return null;
  return (
    <Anchor id="data-use">
      <Card title={t('settings.dataUse.title')} subtitle={t('st.dataUse.desc')}>
        <div className="stack-sm">
          {Object.entries(PURPOSES).map(([p, label]) => (
            <Switch
              key={p}
              label={t(label)}
              checked={!!consents.find((c) => c.purpose === p)?.granted}
              onChange={async (v) => {
                setConsents((cs) => cs?.map((c) => (c.purpose === p ? { ...c, granted: v } : c)) ?? cs);
                await api.me.setConsent(p, v).catch((e) => toast(errorMessage(e)));
                await reload();
              }}
            />
          ))}
        </div>
      </Card>
    </Anchor>
  );
}

/** What the assistant remembers: nothing is added automatically, and anything can be deleted. */
export function MemoryCard() {
  const { toast, t } = useSession();
  const [memories, setMemories] = useState<{ id: string; content: string }[]>([]);
  const [memory, setMemory] = useState('');
  useEffect(() => {
    api.ai
      .memories()
      .then((r) => setMemories(r.items))
      .catch(() => {});
  }, []);
  return (
    <Anchor id="memory">
      <Card title={t('settings.memory.title')} subtitle={t('settings.memory.subtitle')}>
        <div className="stack-sm">
          {memories.length ? (
            <List>
              {memories.map((m) => (
                <ListItem
                  key={m.id}
                  primary={<span style={{ whiteSpace: 'normal', fontWeight: 400 }}>{m.content}</span>}
                  end={
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        await api.ai.deleteMemory(m.id);
                        setMemories((x) => x.filter((y) => y.id !== m.id));
                      }}
                    >
                      {t('settings.delete')}
                    </Button>
                  }
                />
              ))}
            </List>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              {t('settings.memory.none')}
            </p>
          )}
          <form
            className="row"
            style={{ alignItems: 'flex-end' }}
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api.ai.addMemory(memory);
                setMemory('');
                setMemories((await api.ai.memories()).items);
              } catch (e2) {
                toast(errorMessage(e2));
              }
            }}
          >
            <TextField
              label={t('settings.memory.add')}
              value={memory}
              onChange={(e) => setMemory(e.currentTarget.value)}
              maxLength={1000}
              style={{ flex: 1 }}
            />
            <Button type="submit" size="sm" disabled={!memory.trim()}>
              {t('settings.add')}
            </Button>
          </form>
        </div>
      </Card>
    </Anchor>
  );
}
