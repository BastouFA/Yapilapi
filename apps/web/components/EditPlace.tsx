'use client';

import { useState } from 'react';
import { Alert, Button, Card, TextField } from '@yapilapi/design-system';
import { hoursKeyDays, hoursKeyLabel } from '@yapilapi/shared';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { useSession } from '@/app/providers';

/** Monday first, as opening hours are usually written. */
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const INDEX: Record<(typeof DAYS)[number], number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** Each day's hours from however they were written ("tue-sun" fills Tuesday to Sunday; a day of its own wins). */
function hoursByDay(hours: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = Object.entries(hours ?? {})
    .map(([k, v]) => ({ days: hoursKeyDays(k), v: typeof v === 'string' ? v : '' }))
    .filter((x) => x.days)
    .sort((a, b) => b.days!.length - a.days!.length);
  for (const e of entries) for (const d of DAYS) if (e.days!.includes(INDEX[d])) out[d] = e.v;
  return out;
}

/** For the owner: change the place's details, its opening hours and how many people it takes per time slot. */
export function EditPlace({ place, onSaved }: { place: Record<string, any>; onSaved: (place: Record<string, any>) => void }) {
  const { t, toast, locale } = useSession();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState<string>(place.name ?? '');
  const [description, setDescription] = useState<string>(place.description ?? '');
  const [address, setAddress] = useState<string>(place.address ?? '');
  const [city, setCity] = useState<string>(place.city ?? '');
  const [hours, setHours] = useState<Record<string, string>>(() => hoursByDay(place.hours));
  const [capacity, setCapacity] = useState<string>(place.booking_capacity ? String(place.booking_capacity) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const cap = capacity.trim() ? Number(capacity) : null;
  const capOk = cap === null || (Number.isInteger(cap) && cap >= 1 && cap <= 10_000);

  if (!open)
    return (
      <div>
        <Button size="sm" variant="secondary" icon="edit" onClick={() => setOpen(true)}>
          {t('place.edit')}
        </Button>
      </div>
    );
  return (
    <Card title={t('place.edit')}>
      <form
        className="stack-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          setFields({});
          try {
            const r = await api.places.update(place.id, {
              name: name.trim(),
              description: description.trim(),
              address: address.trim() || null,
              city: city.trim() || null,
              hours: Object.fromEntries(DAYS.filter((d) => hours[d]?.trim()).map((d) => [d, hours[d]!.trim()])),
              bookingCapacity: cap,
            });
            toast(t('m.manage.saved'));
            onSaved(r.place);
            setOpen(false);
          } catch (err) {
            setError(errorMessage(err));
            setFields(fieldErrors(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <TextField
          label={t('m.communityForm.name')}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          maxLength={120}
          required
          error={fields.name}
        />
        <TextField label={t('place.edit.about')} multiline value={description} onChange={(e) => setDescription(e.currentTarget.value)} maxLength={2000} />
        <TextField label={t('place.edit.address')} value={address} onChange={(e) => setAddress(e.currentTarget.value)} maxLength={300} />
        <TextField label={t('place.edit.city')} value={city} onChange={(e) => setCity(e.currentTarget.value)} maxLength={100} />
        <fieldset className="stack-sm" style={{ border: 0, margin: 0, padding: 0 }}>
          <legend className="yp-field__label">{t('m.place.hours')}</legend>
          <p className="yp-field__hint" style={{ margin: 0 }}>
            {t('place.edit.hoursHint')}
          </p>
          {DAYS.map((d) => (
            <TextField
              key={d}
              label={hoursKeyLabel(d, locale)}
              placeholder="12:00-22:00"
              value={hours[d] ?? ''}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setHours((h) => ({ ...h, [d]: v }));
              }}
              maxLength={80}
            />
          ))}
          {fields.hours ? <span className="yp-field__error">{fields.hours}</span> : null}
        </fieldset>
        <TextField
          label={t('place.edit.capacity')}
          type="number"
          min={1}
          max={10_000}
          step={1}
          value={capacity}
          onChange={(e) => setCapacity(e.currentTarget.value)}
          hint={t('place.edit.capacityHint')}
          error={fields.bookingCapacity ?? (capOk ? undefined : t('m.eventForm.capacityInvalid'))}
        />
        <div className="row">
          <Button type="submit" size="sm" loading={busy} disabled={!name.trim() || !capOk}>
            {t('common.save')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}
