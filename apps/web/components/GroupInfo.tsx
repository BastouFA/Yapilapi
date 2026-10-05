'use client';

import { useEffect, useState } from 'react';
import { Avatar, BottomSheet, Button, List, ListItem, Menu, TextField, type MenuAction } from '@yapilapi/design-system';
import type { Conversation, Message, PublicUser } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import { PeoplePicker } from './PeoplePicker';

/**
 * A group's name and the people in it. Admins rename it, remove people and choose admins; anyone
 * in it adds people and can leave. Each change writes a line in the chat, which `onLine` gets.
 */
export function GroupInfoSheet({
  open,
  onClose,
  conversation,
  onChanged,
  onLine,
  onLeft,
}: {
  open: boolean;
  onClose: () => void;
  conversation: Conversation;
  /** Load the conversation again (after a change). */
  onChanged: () => void;
  onLine: (m: Message) => void;
  onLeft: () => void;
}) {
  const { t, me, toast } = useSession();
  const admin = conversation.myRole === 'admin';
  const admins = new Set(conversation.adminIds ?? []);
  const [title, setTitle] = useState(conversation.title ?? '');
  const [adding, setAdding] = useState<PublicUser[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (open) setTitle(conversation.title ?? '');
  }, [open, conversation.title]);

  async function run(key: string, action: () => Promise<{ message?: Message | null } | unknown>) {
    setBusy(key);
    try {
      const r = (await action()) as { message?: Message | null } | undefined;
      if (r?.message) onLine(r.message);
      onChanged();
      return true;
    } catch (e) {
      toast(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  const people = [...conversation.members].sort((a, b) => (a.id === me?.id ? -1 : b.id === me?.id ? 1 : Number(admins.has(b.id)) - Number(admins.has(a.id))));
  const actionsFor = (p: PublicUser): MenuAction[] => [
    admins.has(p.id)
      ? {
          label: t('chat.group.dropAdmin'),
          icon: 'user',
          onSelect: () => void run(`role-${p.id}`, () => api.conversations.setRole(conversation.id, p.id, 'member')),
        }
      : {
          label: t('chat.group.makeAdmin'),
          icon: 'check-circle',
          onSelect: () => void run(`role-${p.id}`, () => api.conversations.setRole(conversation.id, p.id, 'admin')),
        },
    {
      label: t('chat.group.remove'),
      icon: 'x-circle',
      danger: true,
      onSelect: () => {
        if (!confirm(t('chat.group.removeConfirm', { name: p.displayName }))) return;
        void run(`remove-${p.id}`, () => api.conversations.removeMember(conversation.id, p.id));
      },
    },
  ];

  return (
    <BottomSheet open={open} onClose={onClose} title={t('chat.group.info')}>
      <div className="stack">
        {admin ? (
          <form
            className="stack-sm"
            onSubmit={(e) => {
              e.preventDefault();
              if (!title.trim() || title.trim() === conversation.title) return;
              void run('title', () => api.conversations.rename(conversation.id, title.trim()));
            }}
          >
            <TextField label={t('chat.group.name')} value={title} maxLength={80} onChange={(e) => setTitle(e.currentTarget.value)} />
            <div>
              <Button type="submit" size="sm" loading={busy === 'title'} disabled={!title.trim() || title.trim() === conversation.title}>
                {t('chat.group.saveName')}
              </Button>
            </div>
          </form>
        ) : null}

        <section className="stack-sm" aria-labelledby="group-people">
          <h2 id="group-people" className="section-title">
            {t('chat.group.people')}
          </h2>
          <List>
            {people.map((p) => (
              <ListItem
                key={p.id}
                start={<Avatar name={p.displayName} src={p.avatarUrl} />}
                primary={p.id === me?.id ? `${p.displayName} (${t('m.chat.you')})` : p.displayName}
                secondary={admins.has(p.id) ? t('chat.group.adminBadge') : `@${p.username}`}
                end={admin && p.id !== me?.id ? <Menu label={t('chat.group.optionsFor', { name: p.displayName })} actions={actionsFor(p)} /> : undefined}
              />
            ))}
          </List>
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            {t('chat.group.adminsNote')}
          </p>
        </section>

        <section className="stack-sm">
          <PeoplePicker picked={adding} onChange={setAdding} label={t('chat.group.add')} exclude={conversation.members.map((m) => m.id)} />
          <div>
            <Button
              size="sm"
              icon="users"
              disabled={!adding.length}
              loading={busy === 'add'}
              onClick={async () => {
                const ok = await run('add', () =>
                  api.conversations.addMembers(
                    conversation.id,
                    adding.map((p) => p.id),
                  ),
                );
                if (ok) setAdding([]);
              }}
            >
              {t('chat.group.addButton')}
            </Button>
          </div>
        </section>

        <div>
          <Button
            variant="danger"
            loading={busy === 'leave'}
            onClick={async () => {
              if (!confirm(t('chat.group.leaveConfirm'))) return;
              setBusy('leave');
              try {
                await api.conversations.leave(conversation.id);
                onLeft();
              } catch (e) {
                toast(errorMessage(e));
                setBusy(null);
              }
            }}
          >
            {t('chat.group.leave')}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}
