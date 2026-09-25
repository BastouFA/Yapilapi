'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@yapilapi/api-client';
import { Button, Dialog, FormField, Input } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { FormError } from '@/components/forms';
import { PersonPicker, type PickedPerson } from './PersonPicker';

/** Start (or reopen) a direct conversation by username. */
export function NewMessageDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (!busy) {
      setUsername('');
      setError(null);
      onClose();
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const u = username.trim().replace(/^@/, '');
    if (!u) return;
    setBusy(true);
    setError(null);
    try {
      const c = await api.conversations.direct({ username: u });
      onCreated();
      setUsername('');
      onClose();
      router.push(`/inbox/${c.id}`);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? t('dm.notFound')
          : describeError(err, t).message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('dm.title')}
      closeLabel={t('common.close')}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form="new-dm-form"
            loading={busy}
            loadingLabel={t('common.working')}
            disabled={!username.trim()}
            data-testid="dm-start"
          >
            {t('dm.start')}
          </Button>
        </>
      }
    >
      <form id="new-dm-form" onSubmit={(e) => void submit(e)} className="stack" noValidate>
        <FormError>{error}</FormError>
        <FormField label={t('dm.username')} description={t('dm.usernameHelp')}>
          <Input
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setError(null);
            }}
            dir="ltr"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={40}
            data-testid="dm-username"
          />
        </FormField>
      </form>
    </Dialog>
  );
}

export function NewGroupDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const api = useApi();
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [people, setPeople] = useState<PickedPerson[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (!busy) {
      setError(null);
      onClose();
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return setError(t('group.needName'));
    if (people.length === 0) return setError(t('group.needMember'));
    setBusy(true);
    setError(null);
    try {
      const c = await api.conversations.createGroup(
        title.trim(),
        people.map((p) => p.id),
      );
      onCreated();
      setTitle('');
      setPeople([]);
      onClose();
      router.push(`/inbox/${c.id}`);
    } catch (err) {
      setError(describeError(err, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('group.title')}
      closeLabel={t('common.close')}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form="new-group-form"
            loading={busy}
            loadingLabel={t('common.working')}
            data-testid="group-create"
          >
            {t('group.create')}
          </Button>
        </>
      }
    >
      <form id="new-group-form" onSubmit={(e) => void submit(e)} className="stack" noValidate>
        <FormError>{error}</FormError>
        <FormField
          label={t('group.name')}
          description={t('group.nameHelp')}
          required
          requiredLabel={t('common.required')}
        >
          <Input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setError(null);
            }}
            maxLength={100}
            autoComplete="off"
            data-testid="group-name"
          />
        </FormField>
        <PersonPicker
          selected={people}
          onChange={(p) => {
            setPeople(p);
            setError(null);
          }}
        />
      </form>
    </Dialog>
  );
}
