import { useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Button, IconButton, Badge, Spinner } from '../components/primitives';
import {
  Checkbox,
  FormField,
  Input,
  Radio,
  RadioGroup,
  Select,
  Switch,
  Textarea,
} from '../components/form';
import { AlertIcon, CloseIcon, ImageIcon, PlusIcon } from '../components/icons';
import { cx } from '../utils';
import type { CircleOption, TopicOption, UserChip, VisibilityKind } from './types';

/** One attachment as the host app tracks it (it owns the actual upload; the composer only reflects state). */
export interface ComposerMediaItem {
  id: string;
  url: string | null;
  kind: 'image' | 'video' | 'audio' | 'file';
  status: 'uploading' | 'ready' | 'failed';
  altText?: string;
  error?: string;
}

export type ComposerVisibility = Extract<
  VisibilityKind,
  'public' | 'followers' | 'friends' | 'circle' | 'selected' | 'private'
>;

export interface ComposerValue {
  body: string;
  visibility: ComposerVisibility;
  circleId?: string;
  audience?: string[];
  topics?: string[];
  poll?: { question: string; options: string[]; multiple: boolean; closesInHours?: number };
  linkUrl?: string;
  latitude?: number;
  longitude?: number;
  mediaIds?: string[];
}

export interface ComposerLabels {
  bodyLabel: string;
  bodyPlaceholder: string;
  counter: (used: number, max: number) => string;
  audienceLegend: string;
  audienceHelp: string;
  visibility: Record<ComposerVisibility, { label: string; description: string }>;
  teenNotice: string;
  teenPublicBlocked: string;
  circleLabel: string;
  circleNone: string;
  circleChoose: string;
  selectedLabel: string;
  selectedHelp: string;
  selectedAdd: string;
  selectedNotFound: string;
  selectedRemove: (name: string) => string;
  selectedList: string;
  selectedEmpty: string;
  topicsLegend: string;
  topicsHelp: (max: number) => string;
  pollToggle: string;
  pollQuestion: string;
  pollOption: (n: number) => string;
  pollAddOption: string;
  pollRemoveOption: (n: number) => string;
  pollMultiple: string;
  pollDuration: string;
  pollDurations: Array<{ hours: number | null; label: string }>;
  linkLabel: string;
  linkHelp: string;
  locationToggle: string;
  locationHelp: string;
  locationTeenBlocked: string;
  locationDenied: string;
  locationReady: string;
  submit: string;
  submitting: string;
  errors: {
    empty: string;
    pollQuestion: string;
    pollOptions: string;
    circle: string;
    audience: string;
    link: string;
    tooLong: string;
    tooMuchMedia: string;
  };
  optional: string;
  media?: {
    attach: string;
    uploading: string;
    remove: (n: number) => string;
    altTextLabel: string;
    altTextPlaceholder: string;
    failed: string;
    retry: string;
  };
}

export interface ComposerProps {
  labels: ComposerLabels;
  topics: TopicOption[];
  circles: CircleOption[];
  isTeen: boolean;
  defaultVisibility?: ComposerVisibility;
  onSubmit: (value: ComposerValue) => Promise<void>;
  onLookupUser: (username: string) => Promise<UserChip | null>;
  /** Ask the browser for coarse coordinates (opt-in). Resolve null when denied/unavailable. */
  onRequestLocation?: () => Promise<{ latitude: number; longitude: number } | null>;
  maxLength?: number;
  circlesHref?: string;
  className?: string;
  /** Attachments the host app is tracking (uploading/ready/failed). Omit to hide the media control entirely. */
  media?: ComposerMediaItem[];
  /** Files the person picked; the host app uploads them and adds the result(s) to `media`. */
  onAddMedia?: (files: FileList) => void;
  onRemoveMedia?: (id: string) => void;
  onSetMediaAltText?: (id: string, altText: string) => void;
  maxMedia?: number;
}

const MAX_TOPICS = 10;
const MAX_MEDIA_DEFAULT = 10;
const VIS_ORDER: ComposerVisibility[] = [
  'public',
  'followers',
  'friends',
  'circle',
  'selected',
  'private',
];

export function Composer({
  labels,
  topics,
  circles,
  isTeen,
  defaultVisibility = 'followers',
  onSubmit,
  onLookupUser,
  onRequestLocation,
  maxLength = 10_000,
  className,
  media,
  onAddMedia,
  onRemoveMedia,
  onSetMediaAltText,
  maxMedia = MAX_MEDIA_DEFAULT,
}: ComposerProps) {
  const base = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const startVis: ComposerVisibility =
    isTeen && defaultVisibility === 'public' ? 'followers' : defaultVisibility;
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<ComposerVisibility>(startVis);
  const [circleId, setCircleId] = useState('');
  const [audience, setAudience] = useState<UserChip[]>([]);
  const [lookup, setLookup] = useState('');
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupBusy, setLookupBusy] = useState(false);
  const [topicSet, setTopicSet] = useState<string[]>([]);
  const [pollOn, setPollOn] = useState(false);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [duration, setDuration] = useState<string>('');
  const [linkUrl, setLinkUrl] = useState('');
  const [locationOn, setLocationOn] = useState(false);
  const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const addUser = async () => {
    const name = lookup.trim().replace(/^@/, '').toLowerCase();
    if (!name) return;
    setLookupBusy(true);
    setLookupError(null);
    try {
      const u = await onLookupUser(name);
      if (!u) setLookupError(labels.selectedNotFound);
      else if (!audience.some((a) => a.id === u.id)) setAudience((a) => [...a, u]);
      if (u) setLookup('');
    } catch {
      setLookupError(labels.selectedNotFound);
    } finally {
      setLookupBusy(false);
    }
  };

  const toggleLocation = async (on: boolean) => {
    setLocationError(null);
    if (!on) {
      setLocationOn(false);
      setCoords(null);
      return;
    }
    if (!onRequestLocation) return;
    const c = await onRequestLocation();
    if (!c) {
      setLocationOn(false);
      setLocationError(labels.locationDenied);
      return;
    }
    setCoords(c);
    setLocationOn(true);
  };

  const readyMedia = (media ?? []).filter((m) => m.status === 'ready');
  const hasMedia = readyMedia.length > 0;

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    const hasPoll = pollOn;
    if (!body.trim() && !hasPoll && !hasMedia) e['body'] = labels.errors.empty;
    if (body.length > maxLength) e['body'] = labels.errors.tooLong;
    if (hasPoll) {
      if (!question.trim()) e['pollQuestion'] = labels.errors.pollQuestion;
      if (options.filter((o) => o.trim()).length < 2) e['pollOptions'] = labels.errors.pollOptions;
    }
    if (visibility === 'circle' && !circleId) e['circle'] = labels.errors.circle;
    if (visibility === 'selected' && audience.length === 0) e['audience'] = labels.errors.audience;
    if (linkUrl.trim()) {
      try {
        const u = new URL(linkUrl.trim());
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
      } catch {
        e['link'] = labels.errors.link;
      }
    }
    return e;
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    const e = validate();
    setErrors(e);
    setSubmitError(null);
    if (Object.keys(e).length) {
      // Move focus to the first invalid control so keyboard and screen-reader users land on it.
      const first = Object.keys(e)[0]!;
      document.getElementById(`${base}-${first}`)?.focus();
      return;
    }
    const value: ComposerValue = { body: body.trim(), visibility };
    if (hasMedia) value.mediaIds = readyMedia.map((m) => m.id);
    if (visibility === 'circle') value.circleId = circleId;
    if (visibility === 'selected') value.audience = audience.map((a) => a.id);
    if (topicSet.length) value.topics = topicSet;
    if (pollOn) {
      value.poll = {
        question: question.trim(),
        options: options.map((o) => o.trim()).filter(Boolean),
        multiple,
      };
      if (duration) value.poll.closesInHours = Number(duration);
    }
    if (linkUrl.trim()) value.linkUrl = linkUrl.trim();
    if (locationOn && coords && !isTeen) {
      value.latitude = coords.latitude;
      value.longitude = coords.longitude;
    }
    setBusy(true);
    try {
      await onSubmit(value);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const nearLimit = body.length > maxLength * 0.9;

  return (
    <form className={cx('yl-composer', className)} onSubmit={(e) => void submit(e)} noValidate>
      {isTeen ? (
        <p className="yl-notice yl-notice--info" role="note">
          {labels.teenNotice}
        </p>
      ) : null}

      <FormField id={`${base}-body`} label={labels.bodyLabel} error={errors['body']}>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={labels.bodyPlaceholder}
          rows={5}
          data-testid="composer-body"
        />
      </FormField>
      <p
        className={cx('yl-composer__counter', nearLimit && 'is-near')}
        aria-live={nearLimit ? 'polite' : 'off'}
      >
        {labels.counter(body.length, maxLength)}
      </p>

      {onAddMedia && labels.media ? (
        <div className="yl-composer__media">
          <input
            ref={fileInput}
            type="file"
            accept="image/*,video/*,audio/*"
            multiple
            hidden
            onChange={(e: ChangeEvent<HTMLInputElement>) => {
              if (e.target.files?.length) onAddMedia(e.target.files);
              e.target.value = '';
            }}
            data-testid="composer-media-input"
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            leadingIcon={<ImageIcon size={16} />}
            onClick={() => fileInput.current?.click()}
            disabled={(media ?? []).length >= maxMedia}
          >
            {labels.media.attach}
          </Button>
          {(media ?? []).length >= maxMedia ? (
            <p className="yl-field__error" role="alert">
              {labels.errors.tooMuchMedia}
            </p>
          ) : null}
          {media && media.length > 0 ? (
            <ul className="yl-composer__mediagrid">
              {media.map((m, i) => (
                <li key={m.id} className="yl-composer__mediaitem">
                  {m.status === 'uploading' ? (
                    <div className="yl-composer__mediaplaceholder">
                      <Spinner label={labels.media!.uploading} size="sm" />
                    </div>
                  ) : m.status === 'failed' ? (
                    <div className="yl-composer__mediaplaceholder yl-composer__mediaplaceholder--error">
                      <AlertIcon size={20} />
                      <span>{m.error || labels.media!.failed}</span>
                    </div>
                  ) : m.kind === 'image' && m.url ? (
                    <img src={m.url} alt="" className="yl-composer__mediathumb" />
                  ) : m.kind === 'video' && m.url ? (
                    <video src={m.url} className="yl-composer__mediathumb" muted />
                  ) : (
                    <div className="yl-composer__mediaplaceholder">{m.kind}</div>
                  )}
                  {onRemoveMedia ? (
                    <IconButton
                      size="sm"
                      variant="soft"
                      label={labels.media!.remove(i + 1)}
                      icon={<CloseIcon size={14} />}
                      className="yl-composer__mediaremove"
                      onClick={() => onRemoveMedia(m.id)}
                    />
                  ) : null}
                  {m.status === 'ready' && m.kind === 'image' && onSetMediaAltText ? (
                    <label className="yl-sr-only" htmlFor={`${base}-alt-${m.id}`}>
                      {labels.media!.altTextLabel}
                    </label>
                  ) : null}
                  {m.status === 'ready' && m.kind === 'image' && onSetMediaAltText ? (
                    <input
                      id={`${base}-alt-${m.id}`}
                      className="yl-composer__mediaalt"
                      value={m.altText ?? ''}
                      placeholder={labels.media!.altTextPlaceholder}
                      onChange={(e) => onSetMediaAltText(m.id, e.target.value)}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <RadioGroup
        legend={labels.audienceLegend}
        description={labels.audienceHelp}
        value={visibility}
        onValueChange={(v) => setVisibility(v as ComposerVisibility)}
        className="yl-composer__audience"
      >
        {VIS_ORDER.map((v) => {
          const blocked = isTeen && v === 'public';
          return (
            <Radio
              key={v}
              value={v}
              card
              disabled={blocked}
              data-testid={`vis-${v}`}
              label={labels.visibility[v].label}
              description={blocked ? labels.teenPublicBlocked : labels.visibility[v].description}
            />
          );
        })}
      </RadioGroup>

      {visibility === 'circle' ? (
        <FormField
          id={`${base}-circle`}
          label={labels.circleLabel}
          error={errors['circle']}
          description={circles.length === 0 ? labels.circleNone : undefined}
        >
          <Select
            value={circleId}
            onChange={(e) => setCircleId(e.target.value)}
            disabled={circles.length === 0}
          >
            <option value="">{labels.circleChoose}</option>
            {circles.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.memberCount})
              </option>
            ))}
          </Select>
        </FormField>
      ) : null}

      {visibility === 'selected' ? (
        <div className="yl-composer__selected">
          <FormField
            id={`${base}-audience`}
            label={labels.selectedLabel}
            description={labels.selectedHelp}
            error={errors['audience'] ?? lookupError ?? undefined}
          >
            <div className="yl-inline-form">
              <Input
                value={lookup}
                onChange={(e) => setLookup(e.target.value)}
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void addUser();
                  }
                }}
                data-testid="audience-input"
              />
              <Button
                variant="secondary"
                onClick={() => void addUser()}
                loading={lookupBusy}
                leadingIcon={<PlusIcon size={16} />}
              >
                {labels.selectedAdd}
              </Button>
            </div>
          </FormField>
          <ul className="yl-chips" aria-label={labels.selectedList}>
            {audience.length === 0 ? (
              <li className="yl-chips__empty">{labels.selectedEmpty}</li>
            ) : null}
            {audience.map((a) => (
              <li key={a.id} className="yl-chip">
                <span dir="ltr">@{a.username}</span>
                <IconButton
                  size="sm"
                  label={labels.selectedRemove(a.displayName)}
                  icon={<CloseIcon size={14} />}
                  onClick={() => setAudience((l) => l.filter((x) => x.id !== a.id))}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {topics.length ? (
        <fieldset className="yl-composer__topics">
          <legend className="yl-radiogroup__legend">
            {labels.topicsLegend} <span className="yl-field__req">({labels.optional})</span>
          </legend>
          <p className="yl-field__desc">{labels.topicsHelp(MAX_TOPICS)}</p>
          <div className="yl-topicgrid">
            {topics.map((t) => {
              const on = topicSet.includes(t.slug);
              return (
                <Checkbox
                  key={t.slug}
                  label={t.name}
                  checked={on}
                  disabled={!on && topicSet.length >= MAX_TOPICS}
                  className="yl-topicchip"
                  onChange={(e) =>
                    setTopicSet((s) =>
                      e.target.checked ? [...s, t.slug] : s.filter((x) => x !== t.slug),
                    )
                  }
                />
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <div className="yl-composer__poll">
        <Switch
          label={labels.pollToggle}
          checked={pollOn}
          onChange={(e) => setPollOn(e.target.checked)}
          data-testid="poll-toggle"
        />
        {pollOn ? (
          <div className="yl-composer__pollfields">
            <FormField
              id={`${base}-pollQuestion`}
              label={labels.pollQuestion}
              error={errors['pollQuestion']}
            >
              <Input
                value={question}
                maxLength={300}
                onChange={(e) => setQuestion(e.target.value)}
                data-testid="poll-question"
              />
            </FormField>
            <div className="yl-composer__options">
              {options.map((o, i) => (
                <div key={i} className="yl-inline-form">
                  <FormField
                    id={i === 0 ? `${base}-pollOptions` : undefined}
                    label={labels.pollOption(i + 1)}
                    error={i === 0 ? errors['pollOptions'] : undefined}
                    className="yl-grow"
                  >
                    <Input
                      value={o}
                      maxLength={200}
                      onChange={(e) =>
                        setOptions((l) => l.map((x, j) => (j === i ? e.target.value : x)))
                      }
                      data-testid={`poll-option-${i}`}
                    />
                  </FormField>
                  {options.length > 2 ? (
                    <IconButton
                      label={labels.pollRemoveOption(i + 1)}
                      icon={<CloseIcon size={16} />}
                      onClick={() => setOptions((l) => l.filter((_, j) => j !== i))}
                    />
                  ) : null}
                </div>
              ))}
              {options.length < 6 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setOptions((l) => [...l, ''])}
                  leadingIcon={<PlusIcon size={16} />}
                >
                  {labels.pollAddOption}
                </Button>
              ) : null}
            </div>
            <Checkbox
              label={labels.pollMultiple}
              checked={multiple}
              onChange={(e) => setMultiple(e.target.checked)}
            />
            <FormField label={labels.pollDuration}>
              <Select value={duration} onChange={(e) => setDuration(e.target.value)}>
                {labels.pollDurations.map((d) => (
                  <option key={String(d.hours)} value={d.hours === null ? '' : String(d.hours)}>
                    {d.label}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
        ) : null}
      </div>

      <FormField
        id={`${base}-link`}
        label={
          <>
            {labels.linkLabel} <span className="yl-field__req">({labels.optional})</span>
          </>
        }
        description={labels.linkHelp}
        error={errors['link']}
      >
        <Input
          type="url"
          inputMode="url"
          dir="ltr"
          value={linkUrl}
          onChange={(e) => setLinkUrl(e.target.value)}
          placeholder="https://"
          autoCapitalize="none"
          spellCheck={false}
        />
      </FormField>

      {onRequestLocation ? (
        <div className="yl-composer__location">
          <Switch
            label={labels.locationToggle}
            description={isTeen ? labels.locationTeenBlocked : labels.locationHelp}
            checked={locationOn}
            disabled={isTeen}
            onChange={(e) => void toggleLocation(e.target.checked)}
            data-testid="location-toggle"
          />
          {locationOn && coords ? <Badge tone="success">{labels.locationReady}</Badge> : null}
          {locationError ? (
            <p className="yl-field__error" role="alert">
              {locationError}
            </p>
          ) : null}
        </div>
      ) : null}

      {submitError ? (
        <p className="yl-notice yl-notice--danger" role="alert">
          {submitError}
        </p>
      ) : null}
      <div className="yl-composer__submit">
        <Button
          type="submit"
          size="lg"
          loading={busy}
          loadingLabel={labels.submitting}
          data-testid="composer-submit"
        >
          {labels.submit}
        </Button>
      </div>
    </form>
  );
}
