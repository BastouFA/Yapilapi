'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, type CreatePlaceInput, type PlaceKind } from '@yapilapi/api-client';
import {
  Button,
  Card,
  FormField,
  Input,
  Radio,
  RadioGroup,
  Textarea,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { describeError } from '@/lib/errors';
import { requestCoarsePosition } from '@/lib/geo';
import { PageHeader } from '@/components/PageHeader';

const KINDS: PlaceKind[] = ['restaurant', 'store', 'venue', 'attraction', 'service'];

export function PlaceAddView() {
  const api = useApi();
  const { t } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const { isTeen } = useSession();

  const [name, setName] = useState('');
  const [kind, setKind] = useState<PlaceKind>('restaurant');
  const [description, setDescription] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [locating, setLocating] = useState(false);
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [website, setWebsite] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const fillMyLocation = async () => {
    setLocating(true);
    const r = await requestCoarsePosition();
    setLocating(false);
    if (r.ok) {
      setLat(String(r.position.latitude));
      setLng(String(r.position.longitude));
    }
  };

  if (isTeen) {
    return (
      <>
        <PageHeader title={t('places.add')} />
        <p className="yl-notice yl-notice--warning">{t('places.teenBlocked')}</p>
      </>
    );
  }

  const submit = async () => {
    setError('');
    if (!name.trim()) {
      setError(t('places.form.errName'));
      return;
    }
    if (!lat || !lng) {
      setError(t('places.form.errLocation'));
      return;
    }
    setBusy(true);
    try {
      const input: CreatePlaceInput = {
        name: name.trim(),
        kind,
        latitude: Number(lat),
        longitude: Number(lng),
      };
      if (description.trim()) input.description = description.trim();
      if (address.trim()) input.address = { line1: address.trim() };
      if (phone.trim()) input.phone = phone.trim();
      if (website.trim()) input.website = website.trim();
      const place = await api.places.create(input);
      toast.show({ tone: 'success', title: t('places.created') });
      router.push(`/places/${encodeURIComponent(place.id)}`);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 409
          ? t('places.form.duplicate')
          : describeError(e, t).message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={t('places.add')} />
      <Card padding="lg" className="stack">
        <FormField label={t('places.form.name')} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </FormField>
        <RadioGroup
          legend={t('places.form.kind')}
          value={kind}
          onValueChange={(v) => setKind(v as PlaceKind)}
        >
          {KINDS.map((k) => (
            <Radio key={k} value={k} label={t(`places.kind.${k}`)} />
          ))}
        </RadioGroup>
        <FormField label={t('places.form.description')}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </FormField>
        <FormField label={t('places.form.location')} description={t('places.form.locationHelp')}>
          <div className="inline-form">
            <Input
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              placeholder="lat"
              inputMode="decimal"
            />
            <Input
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              placeholder="lng"
              inputMode="decimal"
            />
            <Button
              variant="secondary"
              size="sm"
              loading={locating}
              onClick={() => void fillMyLocation()}
            >
              {t('places.form.useMyLocation')}
            </Button>
          </div>
        </FormField>
        <FormField label={t('places.form.address')}>
          <Input value={address} onChange={(e) => setAddress(e.target.value)} />
        </FormField>
        <FormField label={t('places.form.phone')}>
          <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </FormField>
        <FormField label={t('places.form.website')}>
          <Input type="url" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </FormField>
        {error ? (
          <p className="yl-notice yl-notice--danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="button-row">
          <Button onClick={() => void submit()} loading={busy} loadingLabel={t('common.saving')}>
            {t('places.form.submit')}
          </Button>
        </div>
      </Card>
    </>
  );
}
