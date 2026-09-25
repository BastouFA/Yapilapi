'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Conversation } from '@yapilapi/api-client';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  FormField,
  IconButton,
  Input,
  Switch,
  TrashIcon,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { describeError } from '@/lib/errors';
import { useRealtime } from '@/lib/realtime';
import { ConfirmDialog } from '@/components/common';
import { FormError } from '@/components/forms';
import { PersonPicker, type PickedPerson } from './PersonPicker';

const FAR_FUTURE = () => new Date(Date.now() + 100 * 365 * 24 * 3600 * 1000).toISOString();

/** Everything about one conversation that is not the messages: mute, pin, and for groups name, members and leaving. */
export function ConversationDetails({
  conv,
  open,
  onClose,
  onChanged,
}: {
  conv: Conversation;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const { user } = useSession();
  const router = useRouter();
  const toast = useToast();
  const { notifyInboxChanged } = useRealtime();
  const isGroup = conv.kind === 'group';
  const [title, setTitle] = useState(conv.title ?? '');
  const [adding, setAdding] = useState<PickedPerson[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<
    { kind: 'leave' } | { kind: 'remove'; id: string; name: string } | null
  >(null);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      onChanged();
      notifyInboxChanged();
      if (ok) toast.show({ tone: 'success', title: ok });
      return true;
    } catch (e) {
      const d = describeError(e, t);
      setError(d.message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const members = conv.members ?? [];
  const excluded = members.map((m) => m.userId);

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title={t('chatDetails.title')}
        closeLabel={t('common.close')}
        footer={<Button onClick={onClose}>{t('common.done')}</Button>}
      >
        <div className="stack">
          <FormError>{error}</FormError>
          <div className="stack-sm">
            <Switch
              label={t('chatDetails.mute')}
              description={t('chatDetails.muteHelp')}
              checked={conv.me.muted}
              disabled={busy === 'mute'}
              onChange={(e) =>
                void run('mute', () =>
                  api.conversations.updateMine(conv.id, {
                    mutedUntil: e.target.checked ? FAR_FUTURE() : null,
                  }),
                )
              }
              data-testid="detail-mute"
            />
            <Switch
              label={t('chatDetails.pin')}
              checked={conv.me.pinned}
              disabled={busy === 'pin'}
              onChange={(e) =>
                void run('pin', () =>
                  api.conversations.updateMine(conv.id, { pinned: e.target.checked }),
                )
              }
            />
          </div>

          {isGroup ? (
            <>
              {conv.canManage ? (
                <form
                  className="inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (title.trim() && title.trim() !== conv.title)
                      void run(
                        'rename',
                        () => api.conversations.rename(conv.id, title.trim()),
                        t('chatDetails.renamed'),
                      );
                  }}
                >
                  <FormField label={t('chatDetails.rename')}>
                    <Input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      maxLength={100}
                      data-testid="detail-title"
                    />
                  </FormField>
                  <Button
                    type="submit"
                    variant="secondary"
                    loading={busy === 'rename'}
                    loadingLabel={t('common.working')}
                    disabled={!title.trim() || title.trim() === conv.title}
                  >
                    {t('chatDetails.saveName')}
                  </Button>
                </form>
              ) : null}

              <section aria-labelledby="cd-members" className="stack-sm">
                <h3 id="cd-members" className="section-title">
                  {t('chatDetails.members')}{' '}
                  <span className="muted">({conv.memberCount ?? members.length})</span>
                </h3>
                <ul className="person-list">
                  {members.map((m) => (
                    <li key={m.userId} className="person-row">
                      <Avatar
                        name={m.profile?.displayName ?? '?'}
                        src={m.profile?.avatarUrl ?? null}
                        decorative
                      />
                      <div className="person-row__text">
                        {m.profile ? (
                          <Link href={`/u/${m.profile.username}`} className="person-row__name">
                            {m.profile.displayName}
                          </Link>
                        ) : (
                          <span className="person-row__name">{t('inbox.someone')}</span>
                        )}
                        {m.profile ? (
                          <span className="person-row__handle" dir="ltr">
                            @{m.profile.username}
                          </span>
                        ) : null}
                      </div>
                      {m.role === 'owner' || m.role === 'admin' ? (
                        <Badge tone="secondary">
                          {t(
                            m.role === 'owner'
                              ? 'chatDetails.role.owner'
                              : 'chatDetails.role.admin',
                          )}
                        </Badge>
                      ) : null}
                      {conv.canManage && m.userId !== user.id && m.role !== 'owner' ? (
                        <IconButton
                          label={t('chatDetails.remove', { name: m.profile?.displayName ?? '' })}
                          icon={<TrashIcon size={16} />}
                          size="sm"
                          onClick={() =>
                            setConfirm({
                              kind: 'remove',
                              id: m.userId,
                              name: m.profile?.displayName ?? '',
                            })
                          }
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>

              {conv.canManage ? (
                <section aria-labelledby="cd-add" className="stack-sm">
                  <h3 id="cd-add" className="section-title">
                    {t('chatDetails.addPeople')}
                  </h3>
                  <PersonPicker selected={adding} onChange={setAdding} excludeIds={excluded} />
                  <div className="button-row button-row--end">
                    <Button
                      variant="secondary"
                      disabled={adding.length === 0}
                      loading={busy === 'add'}
                      loadingLabel={t('common.working')}
                      onClick={() =>
                        void run(
                          'add',
                          () =>
                            api.conversations.addMembers(
                              conv.id,
                              adding.map((p) => p.id),
                            ),
                          t('chatDetails.added'),
                        ).then((ok) => {
                          if (ok) setAdding([]);
                        })
                      }
                    >
                      {t('chatDetails.addSubmit')}
                    </Button>
                  </div>
                </section>
              ) : null}

              <div>
                <Button
                  variant="danger"
                  onClick={() => setConfirm({ kind: 'leave' })}
                  data-testid="leave-group"
                >
                  {t('chatDetails.leave')}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirm?.kind === 'leave'}
        onClose={() => setConfirm(null)}
        busy={busy === 'leave'}
        danger
        title={t('chatDetails.leaveTitle')}
        description={t('chatDetails.leaveBody')}
        confirmLabel={t('chatDetails.leave')}
        onConfirm={() =>
          void run('leave', () => api.conversations.leave(conv.id)).then((ok) => {
            if (ok) {
              setConfirm(null);
              onClose();
              router.replace('/inbox');
            }
          })
        }
      />
      <ConfirmDialog
        open={confirm?.kind === 'remove'}
        onClose={() => setConfirm(null)}
        busy={busy === 'remove'}
        danger
        title={t('chatDetails.removeTitle', {
          name: confirm?.kind === 'remove' ? confirm.name : '',
        })}
        description={t('chatDetails.removeBody')}
        confirmLabel={t('chatDetails.remove', {
          name: confirm?.kind === 'remove' ? confirm.name : '',
        })}
        onConfirm={() => {
          if (confirm?.kind === 'remove')
            void run('remove', () => api.conversations.removeMember(conv.id, confirm.id)).then(
              (ok) => {
                if (ok) setConfirm(null);
              },
            );
        }}
      />
    </>
  );
}
