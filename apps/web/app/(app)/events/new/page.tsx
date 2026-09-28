'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Button, Checkbox, Select, TextField } from '@yapilapi/design-system';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { useSession } from '../../../providers';

function NewEvent() {
  const { t, toast } = useSession();
  const router = useRouter();
  const communityId = useSearchParams().get('community');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(false);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <form
      className="yp-shell__inner"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const start = String(f.get('start'));
        const end = String(f.get('end') || '');
        setBusy(true);
        setError(null);
        setFields({});
        try {
          const { event } = await api.events.create({
            title: String(f.get('title')),
            description: String(f.get('description') ?? ''),
            startsAt: new Date(start).toISOString(),
            endsAt: end ? new Date(end).toISOString() : undefined,
            timezone: tz,
            locationText: online ? undefined : String(f.get('location') || '') || undefined,
            online,
            capacity: f.get('capacity') ? Number(f.get('capacity')) : undefined,
            visibility: String(f.get('visibility')),
            communityId: communityId ?? undefined,
          });
          toast(t('eventForm.created'));
          router.push(`/events/${event.id}`);
        } catch (err) {
          setError(errorMessage(err));
          setFields(fieldErrors(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="yp-topbar">
        <h1>{t('events.create')}</h1>
      </div>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="stack">
        <TextField label={t('m.eventForm.name')} name="title" required maxLength={120} error={fields.title} />
        <TextField
          label={t('m.eventForm.starts')}
          name="start"
          type="datetime-local"
          required
          hint={t('eventForm.yourTimeZone', { zone: tz })}
          error={fields.startsAt}
        />
        <TextField label={t('m.eventForm.ends')} name="end" type="datetime-local" error={fields.endsAt} />
        <Checkbox label={t('eventForm.online')} checked={online} onChange={(e) => setOnline(e.currentTarget.checked)} />
        {!online ? <TextField label={t('m.eventForm.where')} name="location" maxLength={300} placeholder={t('m.eventForm.addressLabel')} /> : null}
        <TextField label={t('eventForm.capacity')} name="capacity" type="number" min={1} hint={t('eventForm.capacityHint')} />
        <Select label={t('m.eventForm.whoSees')} name="visibility" defaultValue="public">
          <option value="public">{t('m.eventForm.everyone')}</option>
          <option value="followers">{t('m.eventForm.followers')}</option>
          <option value="friends">{t('m.eventForm.friends')}</option>
          <option value="private">{t('m.eventForm.invited')}</option>
        </Select>
        <TextField label={t('m.eventForm.details')} name="description" multiline maxLength={5000} />
      </div>
      <Button type="submit" size="lg" block loading={busy}>
        {t('events.create')}
      </Button>
    </form>
  );
}

export default function NewEventPage() {
  return (
    <Suspense>
      <NewEvent />
    </Suspense>
  );
}
