'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, type MomentExpiry, type MomentVisibility } from '@yapilapi/api-client';
import {
  Button,
  Card,
  CloseIcon,
  FormField,
  IconButton,
  ImageIcon,
  Input,
  RadioGroup,
  Radio,
  Select,
  Spinner,
  Switch,
  AlertIcon,
  Textarea,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useAsync, usePageTitle } from '@/lib/hooks';
import { useMediaUploads } from '@/lib/use-media-uploads';
import { describeError } from '@/lib/errors';
import { requestCoarsePosition } from '@/lib/geo';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView } from '@/components/common';

const VISIBILITIES: MomentVisibility[] = ['public', 'followers', 'friends', 'circle', 'selected'];
const EXPIRIES: MomentExpiry[] = ['1h', '24h', 'custom', 'permanent'];

function kindOf(mediaKind: 'image' | 'video' | 'audio' | 'file'): 'photo' | 'video' | 'audio' {
  if (mediaKind === 'video') return 'video';
  if (mediaKind === 'audio') return 'audio';
  return 'photo';
}

export function MomentCreateView() {
  const api = useApi();
  const { t } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const { isTeen, user } = useSession();
  const media = useMediaUploads(1);
  const fileInput = useRef<HTMLInputElement>(null);
  usePageTitle(t('moments.createTitle'), t('app.name'));

  const circles = useAsync((signal) => api.graph.circles({ signal }), [api]);

  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<MomentVisibility>('followers');
  const [circleId, setCircleId] = useState('');
  const [selected, setSelected] = useState<
    Array<{ id: string; username: string; displayName: string }>
  >([]);
  const [audienceInput, setAudienceInput] = useState('');
  const [audienceError, setAudienceError] = useState('');
  const [expiry, setExpiry] = useState<MomentExpiry>('24h');
  const [customExpiresAt, setCustomExpiresAt] = useState('');
  const [locationOn, setLocationOn] = useState(false);
  const [pos, setPos] = useState<{ latitude: number; longitude: number } | null>(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const item = media.items[0];
  const hasMedia = Boolean(item);

  const addPerson = async () => {
    const username = audienceInput.trim().replace(/^@/, '');
    if (!username) return;
    setAudienceError('');
    try {
      const p = await api.profile.get(username);
      if (selected.some((s) => s.id === p.id)) {
        setAudienceInput('');
        return;
      }
      setSelected((prev) => [
        ...prev,
        { id: p.id, username: p.username, displayName: p.displayName },
      ]);
      setAudienceInput('');
    } catch (e) {
      setAudienceError(
        e instanceof ApiError && e.status === 404
          ? t('composer.selectedNotFound')
          : describeError(e, t).message,
      );
    }
  };

  const toggleLocation = async (on: boolean) => {
    if (!on) {
      setLocationOn(false);
      setPos(null);
      return;
    }
    const r = await requestCoarsePosition();
    if (r.ok) {
      setLocationOn(true);
      setPos(r.position);
    }
  };

  const submit = async () => {
    setError('');
    if (!hasMedia && !body.trim()) {
      setError(t('moments.errEmpty'));
      return;
    }
    if (visibility === 'circle' && !circleId) {
      setError(t('composer.errCircle'));
      return;
    }
    setSubmitting(true);
    try {
      const input: Parameters<typeof api.moments.create>[0] = {
        kind: item ? kindOf(item.kind) : 'text',
        visibility,
      };
      if (body.trim()) input.body = body.trim();
      if (item && !item.id.startsWith('local-')) input.mediaId = item.id;
      if (visibility === 'circle') input.circleId = circleId;
      if (visibility === 'selected') input.audience = selected.map((s) => s.id);
      if (expiry === 'custom' && customExpiresAt) {
        input.expiresAt = new Date(customExpiresAt).toISOString();
      } else {
        input.expiry = expiry;
      }
      if (locationOn && pos) {
        input.latitude = pos.latitude;
        input.longitude = pos.longitude;
      }
      await api.moments.create(input);
      media.reset();
      toast.show({ tone: 'success', title: t('moments.shared') });
      router.push(`/moments/${encodeURIComponent(user.profile.username)}`);
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <PageHeader title={t('moments.createTitle')} lead={t('moments.lead')} />
      <Card padding="lg" className="moment-create__fields">
        <div className="yl-composer__media">
          <input
            ref={fileInput}
            type="file"
            accept="image/*,video/*,audio/*"
            hidden
            onChange={(e) => {
              if (e.target.files?.length) media.addFiles(e.target.files);
              e.target.value = '';
            }}
            data-testid="moment-media-input"
          />
          {!hasMedia ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              leadingIcon={<ImageIcon size={16} />}
              onClick={() => fileInput.current?.click()}
            >
              {t('composer.attachMedia')}
            </Button>
          ) : (
            <ul className="yl-composer__mediagrid">
              <li className="yl-composer__mediaitem">
                {item!.status === 'uploading' ? (
                  <div className="yl-composer__mediaplaceholder">
                    <Spinner label={t('composer.mediaUploading')} size="sm" />
                  </div>
                ) : item!.status === 'failed' ? (
                  <div className="yl-composer__mediaplaceholder yl-composer__mediaplaceholder--error">
                    <AlertIcon size={20} />
                    <span>{item!.error || t('composer.mediaFailed')}</span>
                  </div>
                ) : item!.kind === 'image' && item!.url ? (
                  <img src={item!.url} alt="" className="yl-composer__mediathumb" />
                ) : item!.kind === 'video' && item!.url ? (
                  <video
                    src={item!.url}
                    className="yl-composer__mediathumb"
                    muted
                    controls={false}
                  />
                ) : (
                  <div className="yl-composer__mediaplaceholder">{item!.kind}</div>
                )}
                <IconButton
                  size="sm"
                  variant="soft"
                  label={t('composer.removeMedia', { n: 1 })}
                  icon={<CloseIcon size={14} />}
                  className="yl-composer__mediaremove"
                  onClick={() => media.remove(item!.id)}
                />
              </li>
            </ul>
          )}
        </div>

        <FormField label={t(hasMedia ? 'moments.bodyLabel' : 'moments.textPlaceholder')}>
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={hasMedia ? t('moments.bodyPlaceholder') : t('moments.textPlaceholder')}
            rows={hasMedia ? 2 : 4}
            data-testid="moment-body"
          />
        </FormField>

        <RadioGroup
          legend={t('moments.visibility')}
          value={visibility}
          onValueChange={(v) => setVisibility(v as MomentVisibility)}
        >
          {VISIBILITIES.map((v) => (
            <Radio
              key={v}
              value={v}
              label={t(`moments.visibility.${v}`)}
              disabled={isTeen && v === 'public'}
            />
          ))}
        </RadioGroup>
        {isTeen ? <p className="muted">{t('moments.teenNoPublic')}</p> : null}

        {visibility === 'circle' ? (
          <FormField label={t('composer.circle')}>
            <Select
              value={circleId}
              onChange={(e) => setCircleId(e.target.value)}
              disabled={circles.loading}
            >
              <option value="">{t('composer.circleChoose')}</option>
              {(circles.data?.items ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FormField>
        ) : null}
        {visibility === 'circle' && circles.error ? (
          <ErrorView error={circles.error} onRetry={circles.reload} />
        ) : null}

        {visibility === 'selected' ? (
          <div className="stack-sm">
            <FormField
              label={t('composer.selected')}
              description={t('composer.selectedHelp')}
              error={audienceError || undefined}
            >
              <div className="inline-form">
                <Input
                  value={audienceInput}
                  onChange={(e) => setAudienceInput(e.target.value)}
                  placeholder="@username"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void addPerson();
                    }
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void addPerson()}
                >
                  {t('common.add')}
                </Button>
              </div>
            </FormField>
            <ul className="yl-chips" aria-label={t('composer.selectedList')}>
              {selected.length === 0 ? (
                <li className="yl-chips__empty">{t('composer.selectedEmpty')}</li>
              ) : null}
              {selected.map((s) => (
                <li key={s.id} className="yl-chip">
                  <span dir="ltr">@{s.username}</span>
                  <IconButton
                    size="sm"
                    label={t('composer.selectedRemove', { name: s.displayName })}
                    icon={<CloseIcon size={14} />}
                    onClick={() => setSelected((prev) => prev.filter((x) => x.id !== s.id))}
                  />
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <RadioGroup
          legend={t('moments.expiry')}
          value={expiry}
          onValueChange={(v) => setExpiry(v as MomentExpiry)}
        >
          {EXPIRIES.map((e) => (
            <Radio key={e} value={e} label={t(`moments.expiry.${e}`)} />
          ))}
        </RadioGroup>
        {expiry === 'custom' ? (
          <FormField label={t('moments.expiry.custom')}>
            <Input
              type="datetime-local"
              value={customExpiresAt}
              onChange={(e) => setCustomExpiresAt(e.target.value)}
            />
          </FormField>
        ) : null}

        {!isTeen ? (
          <Switch
            label={t('moments.location')}
            checked={locationOn}
            onChange={(e) => void toggleLocation(e.target.checked)}
          />
        ) : (
          <p className="muted">{t('moments.teenNoLocation')}</p>
        )}

        {error ? (
          <p className="yl-notice yl-notice--danger" role="alert">
            {error}
          </p>
        ) : null}

        <div className="button-row">
          <Button
            onClick={() => void submit()}
            loading={submitting}
            loadingLabel={t('moments.sharing')}
            disabled={hasMedia && item!.status !== 'ready'}
          >
            {t('moments.share')}
          </Button>
        </div>
      </Card>
    </>
  );
}
