'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CreateEventInput, EventDetail, EventVisibility } from '@yapilapi/api-client';
import {
  Button,
  Card,
  FormField,
  Input,
  Radio,
  RadioGroup,
  Switch,
  Textarea,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { describeError } from '@/lib/errors';
import { PageHeader } from '@/components/PageHeader';

const VISIBILITIES: EventVisibility[] = ['public', 'followers', 'friends', 'community', 'private'];
const TEEN_ALLOWED: EventVisibility[] = ['friends', 'community', 'private'];

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Shared by /events/new and /events/[id]/edit. */
export function EventFormView({ existing }: { existing?: EventDetail }) {
  const api = useApi();
  const { t } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const { isTeen } = useSession();

  const [title, setTitle] = useState(existing?.title ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [startsAt, setStartsAt] = useState(toLocalInput(existing?.startsAt ?? null));
  const [endsAt, setEndsAt] = useState(toLocalInput(existing?.endsAt ?? null));
  const [locationText, setLocationText] = useState(existing?.locationText ?? '');
  const [onlineUrl, setOnlineUrl] = useState(existing?.onlineUrl ?? '');
  const [capacity, setCapacity] = useState(existing?.capacity ? String(existing.capacity) : '');
  const [visibility, setVisibility] = useState<EventVisibility>(
    existing?.visibility ?? 'followers',
  );
  const [waitlistEnabled, setWaitlistEnabled] = useState(existing?.waitlistEnabled ?? false);
  const [rules, setRules] = useState(existing?.rules ?? '');
  const [publishNow, setPublishNow] = useState(!existing);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const timezone = existing?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';

  const submit = async () => {
    setError('');
    if (!title.trim()) {
      setError(t('events.form.errTitle'));
      return;
    }
    if (!startsAt) {
      setError(t('events.form.errStarts'));
      return;
    }
    const startIso = new Date(startsAt).toISOString();
    const endIso = endsAt ? new Date(endsAt).toISOString() : undefined;
    if (endIso && new Date(endIso) <= new Date(startIso)) {
      setError(t('events.form.errEnds'));
      return;
    }
    if (isTeen && !TEEN_ALLOWED.includes(visibility)) {
      setError(t('events.teenNoPublic'));
      return;
    }
    setBusy(true);
    try {
      const input: CreateEventInput = {
        title: title.trim(),
        startsAt: startIso,
        timezone,
        visibility,
        waitlistEnabled,
      };
      if (description.trim()) input.description = description.trim();
      if (endIso) input.endsAt = endIso;
      if (locationText.trim()) input.locationText = locationText.trim();
      if (onlineUrl.trim()) input.onlineUrl = onlineUrl.trim();
      if (capacity) input.capacity = Number(capacity);
      if (rules.trim()) input.rules = rules.trim();
      if (!existing) input.publish = publishNow;
      if (existing) {
        await api.events.update(existing.id, input);
        toast.show({ tone: 'success', title: t('events.updated') });
        router.push(`/events/${encodeURIComponent(existing.id)}`);
      } else {
        const ev = await api.events.create(input);
        toast.show({ tone: 'success', title: t('events.created') });
        router.push(`/events/${encodeURIComponent(ev.id)}`);
      }
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={existing ? t('events.edit') : t('events.create')} />
      <Card padding="lg" className="stack">
        <FormField label={t('events.form.title')} required>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            data-testid="event-title"
          />
        </FormField>
        <FormField label={t('events.form.description')}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} />
        </FormField>
        <div className="inline-form">
          <FormField label={t('events.form.startsAt')} required>
            <Input
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
            />
          </FormField>
          <FormField label={t('events.form.endsAt')}>
            <Input
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
            />
          </FormField>
        </div>
        <FormField label={t('events.form.locationText')}>
          <Input value={locationText} onChange={(e) => setLocationText(e.target.value)} />
        </FormField>
        <FormField label={t('events.form.onlineUrl')}>
          <Input type="url" value={onlineUrl} onChange={(e) => setOnlineUrl(e.target.value)} />
        </FormField>
        <FormField label={t('events.form.capacity')}>
          <Input
            type="number"
            min={1}
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
          />
        </FormField>
        <RadioGroup
          legend={t('events.form.visibility')}
          value={visibility}
          onValueChange={(v) => setVisibility(v as EventVisibility)}
        >
          {VISIBILITIES.map((v) => (
            <Radio
              key={v}
              value={v}
              label={t(`visibility.${v}`)}
              disabled={isTeen && !TEEN_ALLOWED.includes(v)}
            />
          ))}
        </RadioGroup>
        {isTeen ? <p className="muted">{t('events.form.teenNotice')}</p> : null}
        <Switch
          label={t('events.form.waitlistEnabled')}
          checked={waitlistEnabled}
          onChange={(e) => setWaitlistEnabled(e.target.checked)}
        />
        <FormField label={t('events.form.rules')}>
          <Textarea value={rules} onChange={(e) => setRules(e.target.value)} rows={3} />
        </FormField>
        {!existing ? (
          <Switch
            label={t('events.form.publishNow')}
            checked={publishNow}
            onChange={(e) => setPublishNow(e.target.checked)}
          />
        ) : null}
        {error ? (
          <p className="yl-notice yl-notice--danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="button-row">
          <Button onClick={() => void submit()} loading={busy} loadingLabel={t('common.saving')}>
            {existing ? t('events.form.submitUpdate') : t('events.form.submitCreate')}
          </Button>
        </div>
      </Card>
    </>
  );
}
